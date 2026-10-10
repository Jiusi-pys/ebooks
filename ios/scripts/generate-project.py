#!/usr/bin/env python3
"""Regenerate the dependency-free Xcode project using stable object identifiers."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
def uid(value): return hashlib.sha256(value.encode()).hexdigest()[:24].upper()
def q(value): return json.dumps(value)
objects = []
def obj(name, body):
    objects.append(f'{uid(name)} = {{ {body} }};')
    return uid(name)
sources = sorted((root / 'Shufang').rglob('*.swift'))
refs, builds = [], []
for file in sources:
    path = file.relative_to(root).as_posix()
    ref = obj(path, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {q(path)}; sourceTree = SOURCE_ROOT;')
    refs.append(ref)
    builds.append(obj('build:' + path, f'isa = PBXBuildFile; fileRef = {ref};'))
asset = obj('assets', 'isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Shufang/Assets.xcassets; sourceTree = SOURCE_ROOT;')
refs.append(asset)
asset_build = obj('build:assets', f'isa = PBXBuildFile; fileRef = {asset};')
font_builds = []
for file in sorted((root / 'Shufang/Fonts').iterdir()):
    if file.suffix not in {'.ttf', '.otf', '.txt'}:
        continue
    path = file.relative_to(root).as_posix()
    file_type = 'file' if file.suffix in {'.ttf', '.otf'} else 'text'
    ref = obj(path, f'isa = PBXFileReference; lastKnownFileType = {file_type}; path = {q(path)}; sourceTree = SOURCE_ROOT;')
    refs.append(ref)
    font_builds.append(obj('build:' + path, f'isa = PBXBuildFile; fileRef = {ref};'))
product = obj('product', 'isa = PBXFileReference; explicitFileType = wrapper.application; path = Shufang.app; sourceTree = BUILT_PRODUCTS_DIR;')
products = obj('products', f'isa = PBXGroup; children = ({product},); name = Products; sourceTree = "<group>";')
main = obj('main', f'isa = PBXGroup; children = ({",".join(refs + [products])},); sourceTree = "<group>";')
source_phase = obj('sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join(builds)},); runOnlyForDeploymentPostprocessing = 0;')
resources = obj('resources', f'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ({",".join([asset_build] + font_builds)},); runOnlyForDeploymentPostprocessing = 0;')
frameworks = obj('frameworks', 'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
for scope in ['project', 'target']:
    configs = []
    for name in ['Debug', 'Release']:
        settings = {'SDKROOT': 'iphoneos', 'IPHONEOS_DEPLOYMENT_TARGET': '17.0', 'SWIFT_VERSION': '5.0', 'CLANG_ENABLE_MODULES': 'YES'}
        if scope == 'target':
            settings.update({'PRODUCT_BUNDLE_IDENTIFIER': 'com.shufang.reader', 'PRODUCT_NAME': 'Shufang', 'INFOPLIST_FILE': 'Shufang/Info.plist', 'TARGETED_DEVICE_FAMILY': '1,2', 'CODE_SIGN_STYLE': 'Automatic', 'GENERATE_INFOPLIST_FILE': 'NO', 'SWIFT_EMIT_LOC_STRINGS': 'YES', 'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon', 'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME': 'AccentColor', 'SUPPORTED_PLATFORMS': 'iphoneos iphonesimulator'})
        if name == 'Debug':
            settings.update({'SWIFT_OPTIMIZATION_LEVEL': '-Onone', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS': 'DEBUG', 'DEBUG_INFORMATION_FORMAT': 'dwarf'})
        else:
            settings.update({'SWIFT_OPTIMIZATION_LEVEL': '-O', 'DEBUG_INFORMATION_FORMAT': 'dwarf-with-dsym', 'VALIDATE_PRODUCT': 'YES'})
        configs.append(obj(scope + name, 'isa = XCBuildConfiguration; name = ' + name + '; buildSettings = {' + ''.join(f'{k} = {q(v)};' for k,v in settings.items()) + '};'))
    obj(scope + 'configs', f'isa = XCConfigurationList; buildConfigurations = ({",".join(configs)},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
target = obj('target', f'isa = PBXNativeTarget; buildConfigurationList = {uid("targetconfigs")}; buildPhases = ({source_phase},{frameworks},{resources},); buildRules = (); dependencies = (); name = Shufang; productName = Shufang; productReference = {product}; productType = "com.apple.product-type.application";')
project = obj('project', f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 2600; }}; buildConfigurationList = {uid("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = zh-Hans; hasScannedForEncodings = 0; knownRegions = ("zh-Hans",en,Base,); mainGroup = {main}; productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = ({target},);')
(root / 'Shufang.xcodeproj/project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(objects) + f'\n}}; rootObject = {project}; }}\n')
(root / 'Shufang.xcodeproj/xcshareddata/xcschemes/Shufang.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Shufang.app" BlueprintName="Shufang" ReferencedContainer="container:Shufang.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Shufang.app" BlueprintName="Shufang" ReferencedContainer="container:Shufang.xcodeproj"/></BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Shufang.app" BlueprintName="Shufang" ReferencedContainer="container:Shufang.xcodeproj"/></BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print('Generated Shufang.xcodeproj')
