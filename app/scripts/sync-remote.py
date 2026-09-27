"""Interactive, host-key-checked SSH helper for the isolated lab.

Install paramiko in .runtime/ssh-libs. Password is read without echo and is
never written to configuration. Each input line is a JSON command.
"""
import getpass
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path('.runtime/ssh-libs').resolve()))
import paramiko

client = paramiko.SSHClient()
client.load_system_host_keys()
client.connect('us.jiusi.org', username='root', password=getpass.getpass('SSH password: '), look_for_keys=False, allow_agent=False, timeout=15)
print('SSH ready', flush=True)
for line in sys.stdin:
    try:
        task = json.loads(line)
        if task['action'] == 'quit':
            break
        if task['action'] == 'put':
            with client.open_sftp() as sftp:
                sftp.put(task['local'], task['remote'])
            print('uploaded', flush=True)
        elif task['action'] == 'run':
            stdin, stdout, stderr = client.exec_command(task['command'], timeout=180)
            if 'stdin' in task:
                stdin.write(task['stdin'])
            stdin.channel.shutdown_write()
            print(stdout.read().decode(), flush=True)
            print(stderr.read().decode(), flush=True)
            print('exit=' + str(stdout.channel.recv_exit_status()), flush=True)
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), flush=True)
client.close()
