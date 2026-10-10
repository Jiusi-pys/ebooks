param([string]$Serial='127.0.0.1:16416',[string]$Evidence='docs/evidence/android-ios/pdf-windows/20261010',[int[]]$Widths=@(320,360,412,600,720,840,1024),[string[]]$Fonts=@('1.0','1.3','2.0'))
$ErrorActionPreference='Stop'
$adb="$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
$originalFont=(& $adb -s $Serial shell settings get system font_scale | Out-String).Trim()
$results=@()
try {
    foreach($font in $Fonts) {
        & $adb -s $Serial shell settings put system font_scale $font | Out-Null
        foreach($width in $Widths) {
            $directory=Join-Path $Evidence "$width-$font";New-Item -ItemType Directory -Force $directory | Out-Null
            $result=(& $adb -s $Serial shell am instrument -w -e windowWidthDp $width -e class org.shufang.android.PdfComparisonTouchTest org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner | Out-String)
            $result | Set-Content -Encoding utf8 "$directory/device.txt"
            if($result -notmatch 'OK \(1 test\)' -or $result -match 'FAILURES|INSTRUMENTATION_FAILED'){throw "PDF window acceptance failed at $width / $font"}
            & $adb -s $Serial pull /sdcard/Android/data/org.shufang.android.acceptance/files/pdf-comparison.json "$directory/metrics.json" | Out-Null
            if($LASTEXITCODE){throw 'Metrics missing'}
            & $adb -s $Serial pull /sdcard/Android/data/org.shufang.android.acceptance/files/pdf-comparison.png "$directory/comparison.png" | Out-Null
            if($LASTEXITCODE){throw 'Screenshot missing'}
            $metrics=Get-Content -LiteralPath "$directory/metrics.json" -Raw | ConvertFrom-Json
            if($metrics.widthDp -ne $width -or [Math]::Abs($metrics.fontScale-[double]$font) -gt .01){throw 'Requested and actual window differ'}
            $results+=@{widthDp=$width;fontScale=$font;metrics=$metrics;passed=$true}
            $results | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $Evidence 'results.json')
        }
    }
}finally {
    if($originalFont -eq 'null'){& $adb -s $Serial shell settings delete system font_scale | Out-Null}else {& $adb -s $Serial shell settings put system font_scale $originalFont | Out-Null}
}
