"""GitHub Actions client: submit exact commit and wait for its durable job."""
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main():
    token = os.environ['DEPLOY_TOKEN']
    sha = os.environ['GITHUB_SHA']
    if len(token) < 32:
        raise SystemExit('Configure the SHUFANG_DEPLOY_TOKEN repository secret')
    endpoint = 'https://us.jiusi.org/api/deploy'

    def request(path='', body=None):
        data = None if body is None else json.dumps(body).encode()
        req = Request(endpoint + path, data=data, headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urlopen(req, timeout=20) as response:
            return json.load(response)

    deadline = time.monotonic() + 2400
    while True:
        try:
            job = request(body={'sha': sha})['job']
            break
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (409, 429, 502, 503, 504):
                raise SystemExit('Deployment request rejected: HTTP ' + str(error.code))
            if time.monotonic() > deadline:
                raise SystemExit('Deployment submission timed out')
            time.sleep(10)
    print('Deployment job ' + job['id'] + ' for ' + sha, flush=True)
    while time.monotonic() < deadline:
        if job['state'] == 'succeeded':
            print('Deployment succeeded')
            return
        if job['state'] == 'failed':
            raise SystemExit(job.get('error', 'Deployment failed'))
        time.sleep(10)
        try:
            job = request('?id=' + job['id'])['job']
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (429, 502, 503, 504):
                raise SystemExit('Deployment status rejected: HTTP ' + str(error.code))
    raise SystemExit('Deployment status timed out; inspect server job before retrying')


if __name__ == '__main__':
    main()
