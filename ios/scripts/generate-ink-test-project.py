"""A hostless iOS XCTest target for real PencilKit conversion; never changes the app project."""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parents[1]
out=root/'.parity-harness'
out.mkdir(exist_ok=True)
objects=[]
def uid(name): return hashlib.sha256(name.encode()).hexdigest()[:24].upper()
def obj(name,body):
    objects.append(f'{uid(name)} = {{ {body} }};')
    return uid(name)
refs=[];builds=[]
for path in ['../Shufang/Core/PortableInk.swift','../Shufang/Core/PortableInkPencil.swift','../ShufangTests/PortableInkPencilTests.swift']:
    ref=obj(path,f'isa=PBXFileReference; lastKnownFileType=sourcecode.swift; path="{path}"; sourceTree=SOURCE_ROOT;')
    refs.append(ref);builds.append(obj('build:'+path,f'isa=PBXBuildFile; fileRef={ref};'))
fixture=obj('fixture','isa=PBXFileReference; lastKnownFileType=text.json; path="android-ink.json"; sourceTree=SOURCE_ROOT;')
fixture_build=obj('fixture-build',f'isa=PBXBuildFile; fileRef={fixture};')
product=obj('product','isa=PBXFileReference; explicitFileType=wrapper.cfbundle; path=ShufangInkParityTests.xctest; sourceTree=BUILT_PRODUCTS_DIR;')
group=obj('main',f'isa=PBXGroup; children=({",".join(refs+[fixture,product])},); sourceTree="<group>";')
sources=obj('sources',f'isa=PBXSourcesBuildPhase; buildActionMask=2147483647; files=({",".join(builds)},); runOnlyForDeploymentPostprocessing=0;')
resources=obj('resources',f'isa=PBXResourcesBuildPhase; buildActionMask=2147483647; files=({fixture_build},); runOnlyForDeploymentPostprocessing=0;')
frameworks=obj('frameworks','isa=PBXFrameworksBuildPhase; buildActionMask=2147483647; files=(); runOnlyForDeploymentPostprocessing=0;')
lists={}
for scope in ['project','target']:
    configs=[]
    for mode in ['Debug','Release']:
        settings='SDKROOT=iphoneos; IPHONEOS_DEPLOYMENT_TARGET=17.0; SWIFT_VERSION=5.0; CLANG_ENABLE_MODULES=YES;'
        if scope=='target':settings+=' PRODUCT_BUNDLE_IDENTIFIER=org.shufang.parity.inktests; PRODUCT_NAME=ShufangInkParityTests; GENERATE_INFOPLIST_FILE=YES; TARGETED_DEVICE_FAMILY="1,2"; CODE_SIGNING_ALLOWED=NO;'
        configs.append(obj(scope+mode,f'isa=XCBuildConfiguration; name={mode}; buildSettings={{ {settings} }};'))
    lists[scope]=obj(scope+'list',f'isa=XCConfigurationList; buildConfigurations=({",".join(configs)},); defaultConfigurationIsVisible=0; defaultConfigurationName=Debug;')
target=obj('target',f'isa=PBXNativeTarget; name=ShufangInkParityTests; productName=ShufangInkParityTests; productReference={product}; productType="com.apple.product-type.bundle.unit-test"; buildConfigurationList={lists["target"]}; buildPhases=({sources},{frameworks},{resources}); buildRules=(); dependencies=();')
project=obj('project',f'isa=PBXProject; buildConfigurationList={lists["project"]}; compatibilityVersion="Xcode 14.0"; developmentRegion=en; knownRegions=(en,Base); mainGroup={group}; projectDirPath=""; projectRoot=""; targets=({target},);')
directory=out/'InkParity.xcodeproj';directory.mkdir(exist_ok=True)
(directory/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion=1; classes={}; objectVersion=56; objects={\n'+'\n'.join(objects)+f'\n}}; rootObject={project}; }}',encoding='utf-8')
schemes=directory/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
reference=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="ShufangInkParityTests.xctest" BlueprintName="ShufangInkParityTests" ReferencedContainer="container:InkParity.xcodeproj"/>'
(schemes/'ShufangInkParityTests.xcscheme').write_text(f'<?xml version="1.0" encoding="UTF-8"?><Scheme version="1.3"><BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug"><Testables><TestableReference skipped="NO">{reference}</TestableReference></Testables></TestAction></Scheme>',encoding='utf-8')
print(directory)
