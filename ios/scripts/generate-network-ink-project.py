"""Independent hostless iOS test target; includes the actual application core."""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parents[1]
out=root/'.network-ink-harness';out.mkdir(exist_ok=True)
objects=[]
def uid(name):return hashlib.sha256(('network:'+name).encode()).hexdigest()[:24].upper()
def obj(name,body):objects.append(f'{uid(name)} = {{ {body} }};');return uid(name)
refs=[];builds=[]
for source in sorted((root/'Shufang/Core').glob('*.swift'))+ [root/'ShufangTests/NetworkInkParityTests.swift']:
    path='../'+source.relative_to(root).as_posix()
    ref=obj(path,f'isa=PBXFileReference; lastKnownFileType=sourcecode.swift; path="{path}"; sourceTree=SOURCE_ROOT;')
    refs.append(ref);builds.append(obj('build:'+path,f'isa=PBXBuildFile; fileRef={ref};'))
fixture=obj('fixture','isa=PBXFileReference; lastKnownFileType=text.json; path="network-ink.json"; sourceTree=SOURCE_ROOT;')
resource=obj('resource',f'isa=PBXBuildFile; fileRef={fixture};')
archive=obj('archive','isa=PBXFileReference; lastKnownFileType=archive.zip; path="cross-study.zip"; sourceTree=SOURCE_ROOT;')
archiveResource=obj('archive-resource',f'isa=PBXBuildFile; fileRef={archive};')
product=obj('product','isa=PBXFileReference; explicitFileType=wrapper.cfbundle; path=NetworkInkParityTests.xctest; sourceTree=BUILT_PRODUCTS_DIR;')
group=obj('main',f'isa=PBXGroup; children=({",".join(refs+[fixture,archive,product])},); sourceTree="<group>";')
sources=obj('sources',f'isa=PBXSourcesBuildPhase; buildActionMask=2147483647; files=({",".join(builds)},); runOnlyForDeploymentPostprocessing=0;')
resources=obj('resources',f'isa=PBXResourcesBuildPhase; buildActionMask=2147483647; files=({resource},{archiveResource},); runOnlyForDeploymentPostprocessing=0;')
frameworks=obj('frameworks','isa=PBXFrameworksBuildPhase; buildActionMask=2147483647; files=(); runOnlyForDeploymentPostprocessing=0;')
lists={}
for scope in ['project','target']:
    configs=[]
    for mode in ['Debug','Release']:
        settings='SDKROOT=iphoneos; IPHONEOS_DEPLOYMENT_TARGET=17.0; SWIFT_VERSION=5.0; CLANG_ENABLE_MODULES=YES;'
        if mode=='Debug':settings+=' SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG;'
        if scope=='target':settings+=' PRODUCT_BUNDLE_IDENTIFIER=org.shufang.parity.networkink; PRODUCT_NAME=NetworkInkParityTests; GENERATE_INFOPLIST_FILE=YES; TARGETED_DEVICE_FAMILY="1,2"; CODE_SIGNING_ALLOWED=NO;'
        configs.append(obj(scope+mode,f'isa=XCBuildConfiguration; name={mode}; buildSettings={{ {settings} }};'))
    lists[scope]=obj(scope+'list',f'isa=XCConfigurationList; buildConfigurations=({",".join(configs)},); defaultConfigurationIsVisible=0; defaultConfigurationName=Debug;')
target=obj('target',f'isa=PBXNativeTarget; name=NetworkInkParityTests; productName=NetworkInkParityTests; productReference={product}; productType="com.apple.product-type.bundle.unit-test"; buildConfigurationList={lists["target"]}; buildPhases=({sources},{frameworks},{resources}); buildRules=(); dependencies=();')
project=obj('project',f'isa=PBXProject; buildConfigurationList={lists["project"]}; compatibilityVersion="Xcode 14.0"; developmentRegion=en; knownRegions=(en,Base); mainGroup={group}; projectDirPath=""; projectRoot=""; targets=({target},);')
directory=out/'NetworkInk.xcodeproj';directory.mkdir(exist_ok=True)
(directory/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion=1; classes={}; objectVersion=56; objects={\n'+'\n'.join(objects)+f'\n}}; rootObject={project}; }}',encoding='utf-8')
schemes=directory/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
reference=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="NetworkInkParityTests.xctest" BlueprintName="NetworkInkParityTests" ReferencedContainer="container:NetworkInk.xcodeproj"/>'
(schemes/'NetworkInkParityTests.xcscheme').write_text(f'<?xml version="1.0" encoding="UTF-8"?><Scheme version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug"><Testables><TestableReference skipped="NO">{reference}</TestableReference></Testables></TestAction></Scheme>',encoding='utf-8')
print(directory)
