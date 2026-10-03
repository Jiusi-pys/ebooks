use serde_json::json;
use shufang_native::books;
use std::io::Write;
#[test]
fn epub_two_ncx_imports_nested_fragment_outline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ncx.epub");
    let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, text) in [
        (
            "META-INF/container.xml",
            r#"<container><rootfile full-path="book.opf"/></container>"#,
        ),
        (
            "book.opf",
            r#"<package><manifest><item id="body" href="body.xhtml"/><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="toc"><itemref idref="body"/></spine></package>"#,
        ),
        (
            "body.xhtml",
            r#"<html><body><h1>Title</h1><p id="one">First</p><p id="two">Second</p></body></html>"#,
        ),
        (
            "toc.ncx",
            r##"<ncx><navMap><navPoint id="first"><navLabel><text>First section</text></navLabel><content src="body.xhtml#one"/><navPoint id="second"><navLabel><text>Nested section</text></navLabel><content src="body.xhtml#two"/></navPoint></navPoint></navMap></ncx>"##,
        ),
    ] {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(text.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    let book = books::parse(&path).unwrap();
    assert_eq!(book["outline"][1]["title"], "First section");
    assert_eq!(book["outline"][2]["title"], "Nested section");
    assert_eq!(book["outline"][2]["depth"], 2);
    assert_eq!(book["outline"][2]["paraIndex"], 2);
}
#[test]
fn epub_rendition_resolves_local_images_and_non_spine_footnotes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("illustrated.epub");
    let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    let png = {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    };
    for (name, content) in [
        ("META-INF/container.xml",br#"<container><rootfile full-path="OPS/book.opf"/></container>"#.as_slice()),
        ("OPS/book.opf",br#"<package><manifest><item id="a" href="text/a.xhtml"/><item id="n" href="notes.xhtml"/><item id="nav" href="nav.xhtml" properties="nav"/></manifest><spine><itemref idref="a"/></spine></package>"#.as_slice()),
        ("OPS/nav.xhtml",br##"<html><body><nav epub:type="toc"><ol><li><a href="text/a.xhtml#body">Body section</a></li></ol></nav></body></html>"##.as_slice()),
        ("OPS/text/a.xhtml",br##"<html><body><p id="body">Body <a href="../notes.xhtml#%6E%31" epub:type="noteref">1</a></p><img src="../images/test%20image.png" alt="Figure"/><img src="../images/unsupported.svg"/><img src="https://evil.test/pixel"/><p>End</p></body></html>"##.as_slice()),
        ("OPS/notes.xhtml",br##"<html><body><aside id="n1" epub:type="footnote"><p>Footnote <script>steal()</script>text</p><a href="text/a.xhtml#body">Back</a></aside></body></html>"##.as_slice()),
        ("OPS/images/test image.png",png.as_slice()),
        ("OPS/images/unsupported.svg",br#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#.as_slice()),
    ] { archive.start_file(name,zip::write::SimpleFileOptions::default()).unwrap(); archive.write_all(content).unwrap(); }
    archive.finish().unwrap();
    let parsed = books::parse(&path).unwrap();
    assert_eq!(parsed["outline"][1]["title"], "Body section");
    assert_eq!(parsed["outline"][1]["paraIndex"], 0);
    assert_eq!(parsed["outline"][0]["id"], "chapter:chapter-1");
    let data = books::epub_rendition(&path).unwrap();
    assert_eq!(data["version"], 1);
    assert_eq!(data["chapters"][0]["paragraphs"][0], "Body 1");
    assert_eq!(data["chapters"][0]["images"].as_array().unwrap().len(), 1);
    assert!(data["chapters"][0]["images"][0]["src"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(
        data["chapters"][0]["links"][0]["target"],
        "OPS/notes.xhtml#n1"
    );
    assert_eq!(
        data["targets"]["OPS/notes.xhtml#n1"]["text"],
        "Footnote textBack"
    );
    assert!(!data.to_string().contains("steal()"));
    assert!(!data.to_string().contains("evil.test"));
}
#[test]
fn plain_text_and_fb2_keep_unicode_chapter_text() {
    let dir = tempfile::tempdir().unwrap();
    let text = dir.path().join("中文.txt");
    std::fs::write(&text, "第一章\n\n中文😀\n段落").unwrap();
    let book = books::parse(&text).unwrap();
    assert_eq!(book["title"], "中文");
    assert!(book["chapters"][0]["paragraphs"]
        .as_array()
        .unwrap()
        .contains(&json!("中文😀")));
    let fb2 = dir.path().join("test.fb2");
    std::fs::write(&fb2,r#"<FictionBook><description><title-info><book-title>书名</book-title><author><first-name>作者</first-name></author></title-info></description><body><section><title><p>章节</p></title><p>内容</p></section></body></FictionBook>"#).unwrap();
    let book = books::parse(&fb2).unwrap();
    assert_eq!(book["title"], "书名");
    assert!(book["chapters"][0]["paragraphs"]
        .to_string()
        .contains("内容"));
}
#[test]
fn epub_uses_spine_order_and_ignores_script_contents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book.epub");
    let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, content) in [
        (
            "META-INF/container.xml",
            r#"<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#,
        ),
        (
            "OPS/content.opf",
            r#"<package><metadata><dc:title>EPUB书</dc:title><dc:creator>作者</dc:creator><dc:publisher>出版社</dc:publisher><dc:language>zh-CN</dc:language><dc:identifier opf:scheme="ISBN">9781234567890</dc:identifier></metadata><manifest><item id="two" href="../Text/two%20words.xhtml" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>"#,
        ),
        (
            "OPS/one.xhtml",
            "<html><body><h1>第一章</h1><p>内容一</p><script>steal()</script></body></html>",
        ),
        (
            "Text/two words.xhtml",
            "<html><body><h1>第二章</h1><p>内容二</p></body></html>",
        ),
    ] {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    let book = books::parse(&path).unwrap();
    assert_eq!(book["title"], "EPUB书");
    assert_eq!(book["metadata"]["publisher"], "出版社");
    assert_eq!(book["metadata"]["identifiers"][0]["scheme"], "ISBN");
    assert_eq!(book["chapters"][0]["title"], "第一章");
    assert!(!book.to_string().contains("steal()"));
    assert_eq!(book["chapters"][1]["title"], "第二章");
}
