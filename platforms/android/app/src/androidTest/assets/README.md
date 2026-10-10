# Test fixture provenance

`epub-editor.epub` is the repository's existing Web EPUB fixture, copied without changes from `app/src/lib/fixtures/epub-editor.epub`.

`sample-kf8.azw3` is the upstream libmobi test fixture `tests/samples/sample-obfuscated-fonts.mobi` at commit `906274205c11944b628da1c553b255acb1af7c55`:
https://github.com/bfabiszewski/libmobi/blob/906274205c11944b628da1c553b255acb1af7c55/tests/samples/sample-obfuscated-fonts.mobi

SHA-256: `34fc67043eeeaa6563481d6ea2fea1b5349cb73e459a1f10e3aa09186f56302e`.
The upstream `COPYING` is preserved as `libmobi-COPYING.txt`. These assets are packaged only into the instrumentation APK, never the application APK.

TXT, FB2, PDF and legacy MOBI test documents contain synthetic test text and are generated in `DocumentParserTest.kt`.
