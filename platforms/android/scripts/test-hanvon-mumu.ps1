param([string]$Serial='127.0.0.1:16416',[int]$VmIndex=1,[switch]$SkipFullSuite,[switch]$OnlyFullSuite,
    [ValidateSet('clear7','n10pro2')][string[]]$Profiles=@('clear7','n10pro2'),
    [string]$Evidence='docs/evidence/android-ios/runtime/hanvon-mumu-final')
$ErrorActionPreference='Stop'
if($SkipFullSuite -and $OnlyFullSuite){throw 'Choose either the full suite or the layout matrix'}
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$evidenceRoot=[IO.Path]::GetFullPath((Join-Path $repo $Evidence))
New-Item -ItemType Directory -Force $evidenceRoot | Out-Null
$adb="$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
$mumu='C:/Program Files/Netease/MuMu/nx_main/mumu-cli.exe'
function Android([string[]]$Arguments) { $out=& $adb -s $Serial @Arguments 2>&1; if($LASTEXITCODE){"ADB failed: $Arguments`n$out" | Add-Content -Encoding utf8 "$evidenceRoot/transport-errors.log";throw "ADB failed: $Arguments : $out"}; return ($out | Out-String) }
function Ready {
    for($i=0;$i -lt 120;$i++) {
        if($i % 10 -eq 0){
            $status=(& $mumu info --vmindex $VmIndex | Out-String | ConvertFrom-Json)
            if(!$status.is_process_started){& $mumu control --vmindex $VmIndex launch | Out-Null}
            & $adb disconnect $Serial *> $null
        }
        & $adb connect $Serial *> $null
        $priorPreference=$ErrorActionPreference
        try {$ErrorActionPreference='Continue';$boot=& $adb -s $Serial shell getprop sys.boot_completed 2>$null}finally{$ErrorActionPreference=$priorPreference}
        if($boot -match '^1$'){return}
        Start-Sleep -Milliseconds 500
    }
    throw 'MuMu did not boot'
}
function Restart {
    & $mumu control --vmindex $VmIndex shutdown | Out-Null
    $stopped=$false
    for($i=0;$i -lt 120;$i++) {
        $info=(& $mumu info --vmindex $VmIndex | Out-String | ConvertFrom-Json)
        if(!$info.is_process_started){$stopped=$true;break}
        Start-Sleep -Milliseconds 500
    }
    if(!$stopped){throw 'MuMu did not stop'}
    & $adb disconnect $Serial *> $null
    & $mumu control --vmindex $VmIndex launch | Out-Null
    Ready
}
Ready
$config=(& $mumu setting --vmindex $VmIndex --key resolution_width.custom --key resolution_height.custom --key resolution_dpi.custom --key resolution_mode --key max_frame_rate | Out-String | ConvertFrom-Json)
$original=[ordered]@{configuration=$config; size=(Android @('shell','wm','size')); density=(Android @('shell','wm','density')); font=(Android @('shell','settings','get','system','font_scale')).Trim()}
$original | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$evidenceRoot/original-settings.json"
$deviceProfiles=@(@{name='clear7';width=1264;height=1680},@{name='n10pro2';width=1860;height=2480}) | Where-Object {$_.name -in $Profiles}
$rows=[Collections.Generic.List[object]]::new()
$fixtureRoot=Join-Path $repo ('.tools/hanvon-fixture-'+[guid]::NewGuid())
New-Item -ItemType Directory -Force $fixtureRoot | Out-Null
Copy-Item -LiteralPath "$repo/base/target/debug/examples/android_fixture_server.exe" -Destination "$fixtureRoot/server.exe"
$fixture=Start-Process -FilePath "$fixtureRoot/server.exe" -ArgumentList $fixtureRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$fixtureRoot/server.log" -RedirectStandardError "$fixtureRoot/server-error.log"
try {
    Start-Sleep -Milliseconds 800
    if($fixture.HasExited){throw 'Isolated fixture did not start'}
    foreach($profile in $deviceProfiles) {
        & $mumu setting --vmindex $VmIndex --key resolution_mode --value custom --key resolution_width.custom --value $profile.height --key resolution_height.custom --value $profile.width --key resolution_dpi.custom --value 300 --key max_frame_rate --value 60 | Out-Null
        if($LASTEXITCODE){throw 'MuMu configuration failed'}
        Restart
        Android @('shell','wm','size','reset') | Out-Null
        Android @('shell','wm','density','reset') | Out-Null
        Android @('reverse','tcp:31487','tcp:31487') | Out-Null
        $actual=(Android @('shell','wm','size')).Trim()
        if($actual -notmatch "Physical size: $($profile.width)x$($profile.height)"){throw "Unexpected physical size: $actual"}
        $device=[ordered]@{profile=$profile.name;size=$actual;density=(Android @('shell','wm','density')).Trim();android=(Android @('shell','getprop','ro.build.version.release')).Trim();abi=(Android @('shell','getprop','ro.product.cpu.abi')).Trim();webview=(Android @('shell','dumpsys','webviewupdate'))}
        $device | ConvertTo-Json | Set-Content -Encoding utf8 "$evidenceRoot/$($profile.name)-device.json"
        Android @('logcat','-c') | Out-Null
        if(!$SkipFullSuite) {
            Android @('shell','settings','put','system','font_scale','1.0') | Out-Null
            Write-Output "$($profile.name): full suite"
            $log=Android @('shell','am','instrument','-w','org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner')
            $log | Set-Content -Encoding utf8 "$evidenceRoot/$($profile.name)-suite.log"
            $rows.Add(@{profile=$profile.name;kind='full-suite';passed=($log -match 'OK \(\d+ tests\)' -and $log -notmatch 'FAILURES|INSTRUMENTATION_FAILED')})
        }
        $cases=@()
        foreach($orientation in @('portrait','landscape')) {foreach($font in @('1.0','1.3','2.0')) {$cases+=@{orientation=$orientation;font=$font;density=300}}}
        foreach($dpi in @(240,320)) {$cases+=@{orientation='portrait';font='1.0';density=$dpi}}
        if($OnlyFullSuite){$cases=@()}
        $activeDensity=300
        foreach($case in $cases) {
            $label="$($profile.name)-$($case.orientation)-font$($case.font)-dpi$($case.density)"
            $directory=Join-Path $evidenceRoot $label
            New-Item -ItemType Directory -Force $directory | Out-Null
            if($activeDensity -ne $case.density) {
                & $mumu setting --vmindex $VmIndex --key resolution_dpi.custom --value $case.density | Out-Null
                Restart
                Android @('shell','wm','density','reset') | Out-Null
                Android @('reverse','tcp:31487','tcp:31487') | Out-Null
                $activeDensity=$case.density
            }
            Android @('shell','settings','put','system','font_scale',$case.font) | Out-Null
            foreach($class in @('ReadingDesignTest','PdfComparisonTouchTest')) {
                Write-Output "$label : $class"
                $log=Android @('shell','am','instrument','-w','-e','orientation',$case.orientation,'-e','class',"org.shufang.android.$class",'org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner')
                $log | Set-Content -Encoding utf8 "$directory/$class.log"
                $passed=$log -match 'OK \(1 test\)' -and $log -notmatch 'FAILURES|INSTRUMENTATION_FAILED'
                $rows.Add(@{profile=$profile.name;kind=$class;orientation=$case.orientation;font=$case.font;density=$case.density;passed=$passed})
                if($passed) {
                    $files=if($class -eq 'ReadingDesignTest'){@('redesign-shelf.png','redesign-reader.png','redesign-notes.png','redesign-settings.png','redesign-settings-landscape.png','metrics-shelf.json','metrics-reader.json','metrics-notes.json','metrics-settings.json','metrics-settings-landscape.json')}else{@('pdf-comparison.png','pdf-comparison.json')}
                    foreach($file in $files){Android @('pull',"/sdcard/Android/data/org.shufang.android.acceptance/files/$file","$directory/$file") | Out-Null}
                    $metrics=Get-Content "$directory/$(if($class -eq 'ReadingDesignTest'){'metrics-reader.json'}else{'pdf-comparison.json'})" -Raw | ConvertFrom-Json
                    if($metrics.densityDpi -ne $case.density -or [math]::Abs($metrics.fontScale-[double]$case.font) -gt .01){throw "Metrics mismatch: $label"}
                    if(($case.orientation -eq 'portrait' -and $metrics.widthDp -gt $metrics.heightDp) -or ($case.orientation -eq 'landscape' -and $metrics.widthDp -lt $metrics.heightDp)){throw "Orientation mismatch: $label"}
                }
                $rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$evidenceRoot/results.json"
            }
        }
        Android @('logcat','-d','-v','threadtime') | Set-Content -Encoding utf8 "$evidenceRoot/$($profile.name)-logcat.log"
        $rows | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "$evidenceRoot/results.json"
    }
} finally {
    if(!$fixture.HasExited){Stop-Process -Id $fixture.Id}
    & $mumu setting --vmindex $VmIndex --key resolution_mode --value $config.resolution_mode --key resolution_width.custom --value $config.'resolution_width.custom' --key resolution_height.custom --value $config.'resolution_height.custom' --key resolution_dpi.custom --value $config.'resolution_dpi.custom' --key max_frame_rate --value $config.max_frame_rate | Out-Null
    Restart
    $size=if($original.size -match 'Override size: (\S+)'){$Matches[1]}else{'reset'}
    $density=if($original.density -match 'Override density: (\S+)'){$Matches[1]}else{'reset'}
    Android @('shell','wm','size',$size) | Out-Null
    Android @('shell','wm','density',$density) | Out-Null
    Android @('shell','settings','put','system','font_scale',$original.font) | Out-Null
    Android @('shell','am','start','-n','org.shufang.android/.MainActivity') | Out-Null
    @{size=(Android @('shell','wm','size'));density=(Android @('shell','wm','density'));font=(Android @('shell','settings','get','system','font_scale')).Trim()} | ConvertTo-Json | Set-Content -Encoding utf8 "$evidenceRoot/restored-settings.json"
}
if(@($rows | Where-Object {!$_.passed}).Count){throw 'Hanvon profile acceptance has failures; inspect results.json'}
Write-Output "Completed $($rows.Count) recorded runs; simulator settings restored"
