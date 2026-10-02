#!/usr/bin/env python3
"""Keep Xcode workspace metadata outside iCloud, referencing original sources."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1]
destination = Path.home() / "Library/Developer/Shufang"
project = destination / "Shufang.xcodeproj"
state_file = destination / "source-state.json"
original = source / "Shufang.xcodeproj"
files = [original / "project.pbxproj", *sorted((original / "xcshareddata").rglob("*.xcscheme"))]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


source_state = {str(p.relative_to(original)): digest(p) for p in files}
def project_data(contents):
    with tempfile.NamedTemporaryFile(suffix=".pbxproj") as temporary:
        temporary.write(contents.encode())
        temporary.flush()
        result = subprocess.run(["plutil", "-convert", "json", "-o", "-", temporary.name],
                                check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def team_only_change(current, baseline):
    actual = project_data(current)
    expected = project_data(baseline)
    teams = set()
    for obj in actual["objects"].values():
        settings = obj.get("buildSettings", {})
        if "DEVELOPMENT_TEAM" in settings:
            teams.add(settings.pop("DEVELOPMENT_TEAM"))
    return actual == expected and len(teams) == 1 and next(iter(teams)).isalnum(), next(iter(teams), None)


state = json.loads(state_file.read_text()) if state_file.exists() else None
if state:
    if state["source"] != str(source):
        raise SystemExit("本地入口属于另一份仓库，请先检查 ~/Library/Developer/Shufang。")

text = files[0].read_text()
text, count = re.subn(
    r'path = ("Shufang/[^";]+"|Shufang/[^;]+); sourceTree = SOURCE_ROOT;',
    lambda match: 'path = ' + json.dumps(str(source / match[1].strip('"')))
    + '; sourceTree = "<absolute>";', text,
)
if not count or 'INFOPLIST_FILE = "Shufang/Info.plist";' not in text:
    raise SystemExit("工程结构已变化，请更新本地入口生成器。")
text = text.replace('INFOPLIST_FILE = "Shufang/Info.plist";',
                    'INFOPLIST_FILE = ' + json.dumps(str(source / "Shufang/Info.plist")) + ';')
generated_baseline = text
baseline = state.get("baseline", text) if state else text
team = None
if state:
    local = project / "project.pbxproj"
    if local.exists():
        allowed, selected_team = team_only_change(local.read_text(), baseline)
        if allowed:
            team = selected_team
        elif digest(local) != state["generated"]["project.pbxproj"]:
            raise SystemExit("原工程与本地 Xcode 配置都已修改。请先合并配置，避免覆盖签名设置。")
    if state["files"] == source_state and all((project / p).exists() for p in source_state):
        state["baseline"] = baseline
        state["generated"] = {p: digest(project / p) for p in source_state}
        state_file.write_text(json.dumps(state, indent=2))
        print(project)
        raise SystemExit(0)
if team:
    text = text.replace('CODE_SIGN_STYLE = "Automatic";',
                        'CODE_SIGN_STYLE = "Automatic";DEVELOPMENT_TEAM = ' + json.dumps(team) + ';')
project.mkdir(parents=True, exist_ok=True)
# Preserve an existing unregistered configuration rather than overwriting it.
target = project / "project.pbxproj"
if target.exists() and not state_file.exists() and target.read_text() != text:
    raise SystemExit("发现已有本地配置，请先备份并检查，未覆盖。")
target.write_text(text)
for path in files[1:]:
    target = project / path.relative_to(original)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or not state or digest(target) == state["generated"].get(str(path.relative_to(original))):
        shutil.copyfile(path, target)
state_file.write_text(json.dumps({
    "source": str(source), "files": source_state,
    "baseline": generated_baseline,
    "generated": {p: digest(project / p) for p in source_state},
}, indent=2))
print(project)
