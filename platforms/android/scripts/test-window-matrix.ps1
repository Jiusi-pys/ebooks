param([string]$Serial="127.0.0.1:16416",[string]$AndroidSdk="$env:LOCALAPPDATA/Android/Sdk",[int[]]$Widths=@(320,360,412,600,720,840,1024),[double[]]$FontScales=@(1.0,1.3,2.0))
$ErrorActionPreference="Stop"
$adb="$AndroidSdk/platform-tools/adb.exe"
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$output="$repo/docs/evidence/android-ios/windows"
New-Item -ItemType Directory -Force $output | Out-Null
$size=(& $adb -s $Serial shell wm size | Out-String)
$density=(& $adb -s $Serial shell wm density | Out-String)
$font=(& $adb -s $Serial shell settings get system font_scale | Out-String).Trim()
$results=@()
try {
    foreach($width in $Widths){foreach($scale in $FontScales){
        $name="w$width-font$($scale.ToString([Globalization.CultureInfo]::InvariantCulture))"
        & $adb -s $Serial shell settings put system font_scale ($scale.ToString([Globalization.CultureInfo]::InvariantCulture)) | Out-Null
        & $adb -s $Serial shell am force-stop org.shufang.android.acceptance | Out-Null
        $run=(& $adb -s $Serial shell am instrument -w -e windowWidthDp $width -e class org.shufang.android.ReadingDesignTest org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner | Out-String)
        $run | Set-Content -Encoding utf8 "$output/$name.txt"
        $passed=$run -match 'OK \(1 test\)'
        $folder="$output/$name";New-Item -ItemType Directory -Force $folder | Out-Null
        & $adb -s $Serial pull /sdcard/Android/data/org.shufang.android.acceptance/files/. $folder | Out-Null
        $results+=@{widthDp=$width;heightDp=1280;density=160;fontScale=$scale;passed=$passed;portraitAndLandscape=$true}
        Write-Output "$name : $passed"
    }}
}finally {
    if($size -match 'Override size: (\d+x\d+)'){& $adb -s $Serial shell wm size $Matches[1] | Out-Null}else{& $adb -s $Serial shell wm size reset | Out-Null}
    if($density -match 'Override density: (\d+)'){& $adb -s $Serial shell wm density $Matches[1] | Out-Null}else{& $adb -s $Serial shell wm density reset | Out-Null}
    if($font -eq 'null'){& $adb -s $Serial shell settings delete system font_scale | Out-Null}else{& $adb -s $Serial shell settings put system font_scale $font | Out-Null}
    $results | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$output/results.json"
}
if(@($results | Where-Object {!$_.passed}).Count){throw "One or more window profiles failed; see the evidence report"}
