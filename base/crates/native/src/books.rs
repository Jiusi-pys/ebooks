use quick_xml::{events::Event, Reader};
use scraper::{Html, Selector};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Component, Path},
};

type Result<T> = std::result::Result<T, String>;
const MAX_SOURCE: u64 = 512 * 1024 * 1024;
const MAX_TEXT: u64 = 32 * 1024 * 1024;
pub fn cover_data(path: &Path) -> Result<String> {
    use base64::Engine;
    let bytes = read_limited(
        File::open(path).map_err(|e| e.to_string())?,
        8 * 1024 * 1024,
    )?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "invalid_cover")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "invalid_cover")?
        .thumbnail(512, 768);
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|_| "cover_encoding_failed")?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    ))
}

pub fn parse(path: &Path) -> Result<Value> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size == 0 || size > MAX_SOURCE {
        return Err("invalid_book_size".into());
    }
    let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("书籍");
    let format = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mut book = match format.as_str() {
        "epub" => epub(path)?,
        "txt" => {
            let bytes = read_limited(File::open(path).map_err(|e| e.to_string())?, MAX_TEXT)?;
            let decoded = decode(&bytes);
            let paragraphs: Vec<_> = decoded
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            json!({"title":title,"author":"","chapters":[{"id":"chapter-1","title":title,"paragraphs":paragraphs}]})
        }
        "fb2" => {
            let xml = decode(&read_limited(
                File::open(path).map_err(|e| e.to_string())?,
                MAX_TEXT,
            )?);
            let elements = xml_elements(&xml)?;
            let title = elements
                .iter()
                .find(|n| n.name == "book-title")
                .map(|n| n.text.as_str())
                .unwrap_or(title);
            let author = elements
                .iter()
                .filter(|n| n.path.contains("/author/"))
                .map(|n| n.text.trim())
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let paragraphs = elements
                .iter()
                .filter(|n| n.name == "p" && n.path.contains("/body/"))
                .map(|n| n.text.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            json!({"title":title,"author":author,"chapters":[{"id":"chapter-1","title":title,"paragraphs":paragraphs}]})
        }
        "pdf" => super::pdf::parse(path)?,
        "mobi" | "azw" | "azw3" => kindle(path)?,
        _ => return Err("unsupported_format".into()),
    };
    book["format"] = if format == "azw" {
        "mobi".into()
    } else {
        format.into()
    };
    book["progress"] =
        json!({"chapterId":book["chapters"][0]["id"].as_str().unwrap_or(""),"ratio":0});
    book["coverTone"] = 0.into();
    Ok(book)
}

fn kindle(path: &Path) -> Result<Value> {
    let executable = super::dependency_path("mobitool.exe", "SHUFANG_MOBITOOL")?;
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    // Use an ASCII input filename: the C tool's fopen does not accept Windows
    // Unicode paths. The original name still supplies the fallback book title.
    let input = dir.path().join("input.mobi");
    std::fs::copy(path, &input).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(executable);
    command
        .args(["-e", "-o"])
        .arg(dir.path())
        .arg(&input)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err("invalid_or_encrypted_kindle_book".into());
            }
            break;
        }
        if start.elapsed() > std::time::Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("kindle_parser_timeout".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let output = std::fs::read_dir(dir.path())
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "epub"))
        .ok_or("kindle_output_missing")?;
    epub(&output)
}

fn read_limited(mut reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("book_text_limit".into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, offset)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding.decode(&bytes[offset..]).0.into_owned();
    }
    if let Ok(value) = std::str::from_utf8(bytes) {
        return value.into();
    }
    encoding_rs::GBK.decode(bytes).0.into_owned()
}
struct XmlElement {
    name: String,
    path: String,
    attrs: BTreeMap<String, String>,
    text: String,
}
fn xml_elements(xml: &str) -> Result<Vec<XmlElement>> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<XmlElement> = Vec::new();
    let mut nodes = Vec::new();
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("invalid_xml: {e}"))?
        {
            Event::Start(e) | Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                let attrs = e
                    .attributes()
                    .map(|a| {
                        let a = a.map_err(|e| e.to_string())?;
                        Ok((
                            String::from_utf8_lossy(a.key.as_ref()).to_string(),
                            a.unescape_value().map_err(|e| e.to_string())?.into_owned(),
                        ))
                    })
                    .collect::<Result<BTreeMap<_, _>>>()?;
                let path = format!(
                    "{}/{}",
                    stack.last().map(|n| n.path.as_str()).unwrap_or(""),
                    name
                );
                let node = XmlElement {
                    name,
                    path,
                    attrs,
                    text: String::new(),
                };
                // Quick XML reports empty elements without an end event.
                if xml.as_bytes().get(reader.buffer_position() as usize - 2) == Some(&b'/') {
                    nodes.push(node);
                } else {
                    stack.push(node);
                }
                if stack.len() > 128 || nodes.len() > 200_000 {
                    return Err("xml_limit".into());
                }
            }
            Event::Text(e) => {
                let decoded = e.decode().map_err(|e| e.to_string())?;
                let text = quick_xml::escape::unescape(&decoded).map_err(|e| e.to_string())?;
                for n in &mut stack {
                    n.text.push_str(&text);
                }
            }
            Event::CData(e) => {
                let text = e.decode().map_err(|e| e.to_string())?;
                for n in &mut stack {
                    n.text.push_str(&text);
                }
            }
            Event::End(_) => {
                if let Some(node) = stack.pop() {
                    nodes.push(node);
                }
            }
            Event::DocType(_) => return Err("xml_doctype_not_supported".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(nodes)
}
fn archive_href(folder: &str, href: &str) -> Result<String> {
    let href = href.split('#').next().unwrap_or("");
    if href.starts_with('/') || href.contains([':', '\\', '?']) {
        return Err("invalid_archive_path".into());
    }
    let mut decoded = Vec::new();
    let mut bytes = href.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hi = bytes
                .next()
                .and_then(|v| (v as char).to_digit(16))
                .ok_or("invalid_archive_path")?;
            let lo = bytes
                .next()
                .and_then(|v| (v as char).to_digit(16))
                .ok_or("invalid_archive_path")?;
            decoded.push((hi * 16 + lo) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "invalid_archive_path")?;
    if decoded.starts_with('/') || decoded.contains([':', '\\', '\0']) {
        return Err("invalid_archive_path".into());
    }
    let combined = format!("{folder}{decoded}");
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or("invalid_archive_path")?;
            }
            _ => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}
fn decode_fragment(value: &str) -> Result<String> {
    if value.len() > 4096 {
        return Err("invalid_epub_fragment".into());
    }
    let mut bytes = value.bytes();
    let mut output = Vec::new();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let hi = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("invalid_epub_fragment")?;
            let lo = bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or("invalid_epub_fragment")?;
            output.push((hi * 16 + lo) as u8);
        } else {
            output.push(byte);
        }
    }
    let decoded = String::from_utf8(output).map_err(|_| "invalid_epub_fragment")?;
    if decoded.contains('\0') {
        return Err("invalid_epub_fragment".into());
    }
    Ok(decoded)
}
fn safe_text(element: scraper::ElementRef<'_>) -> String {
    element
        .descendants()
        .filter_map(|n| n.value().as_text().map(|t| (n, t)))
        .filter(|(n, _)| {
            !n.ancestors().any(|a| {
                a.value()
                    .as_element()
                    .is_some_and(|e| ["script", "style"].contains(&e.name()))
            })
        })
        .map(|(_, t)| t.to_string())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Presentation-neutral rendition v1. Imported markup is never returned.
/// Recomputed from originals so upgrading never changes saved paragraph anchors.
pub fn epub_rendition(path: &Path) -> Result<Value> {
    use base64::Engine;
    let book = epub(path)?;
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut budget = 128 * 1024 * 1024;
    fn read(zip: &mut zip::ZipArchive<File>, name: &str, budget: &mut u64) -> Result<Vec<u8>> {
        let normalized = archive_href("", name)?;
        if normalized != name {
            return Err("invalid_archive_path".into());
        }
        let bytes = read_limited(
            zip.by_name(name).map_err(|_| "epub_resource_missing")?,
            MAX_TEXT.min(*budget),
        )?;
        *budget = budget
            .checked_sub(bytes.len() as u64)
            .ok_or("archive_size_limit")?;
        Ok(bytes)
    }
    let container = xml_elements(&decode(&read(
        &mut zip,
        "META-INF/container.xml",
        &mut budget,
    )?))?;
    let opf = container
        .iter()
        .find(|n| n.name == "rootfile")
        .and_then(|n| n.attrs.get("full-path"))
        .ok_or("epub_root_missing")?;
    let package = xml_elements(&decode(&read(&mut zip, opf, &mut budget)?))?;
    let folder = opf
        .rsplit_once('/')
        .map(|(d, _)| format!("{d}/"))
        .unwrap_or_default();
    let manifest: BTreeMap<_, _> = package
        .iter()
        .filter(|n| n.name == "item")
        .filter_map(|n| Some((n.attrs.get("id")?, n.attrs.get("href")?)))
        .collect();
    let spine: Vec<_> = package
        .iter()
        .filter(|n| n.name == "itemref")
        .map(|n| {
            archive_href(
                &folder,
                manifest
                    .get(n.attrs.get("idref").ok_or("epub_spine_id_missing")?)
                    .ok_or("epub_spine_target_missing")?,
            )
        })
        .collect::<Result<_>>()?;
    let mut files = spine.clone();
    for href in manifest.values() {
        if let Ok(name) = archive_href(&folder, href) {
            if (name.ends_with(".xhtml") || name.ends_with(".html")) && !files.contains(&name) {
                files.push(name);
            }
        }
    }
    let blocks = Selector::parse("h1,h2,h3,h4,p,li,blockquote,pre").unwrap();
    let all = Selector::parse("*").unwrap();
    let mut targets = serde_json::Map::new();
    let mut chapters = Vec::new();
    let mut assets = BTreeMap::<String, String>::new();
    let mut image_bytes = 0usize;
    let mut rendered_image_bytes = 0usize;
    for name in files {
        let document = Html::parse_document(&decode(&read(&mut zip, &name, &mut budget)?));
        let local_folder = name
            .rsplit_once('/')
            .map(|(d, _)| format!("{d}/"))
            .unwrap_or_default();
        let chapter_index = spine.iter().position(|s| s == &name);
        let paragraph_nodes: Vec<_> = document
            .select(&blocks)
            .filter(|e| e.select(&blocks).count() == 0 && !safe_text(*e).is_empty())
            .collect();
        let mut links = Vec::new();
        let mut images = Vec::new();
        for element in document.select(&all) {
            if element.ancestors().any(|a| {
                a.value()
                    .as_element()
                    .is_some_and(|e| ["script", "style"].contains(&e.name()))
            }) {
                continue;
            }
            let para = paragraph_nodes.iter().position(|p| {
                p.id() == element.id() || element.ancestors().any(|a| a.id() == p.id())
            });
            if let Some(id) = element
                .value()
                .attr("id")
                .filter(|s| !s.is_empty() && s.len() < 1024)
            {
                let anchor_para = para.or_else(|| {
                    paragraph_nodes
                        .iter()
                        .position(|p| p.ancestors().any(|a| a.id() == element.id()))
                });
                let mut target = json!({"text":safe_text(element)});
                if let Some(index) = chapter_index {
                    target["chapterId"] = book["chapters"][index]["id"].clone();
                    if let Some(p) = anchor_para {
                        target["paraIndex"] = p.into();
                    }
                }
                targets.insert(format!("{name}#{id}"), target);
            }
            if element.value().name() == "a" {
                if let Some(href) = element.value().attr("href") {
                    if let Some((file, fragment)) = href.split_once('#') {
                        let Ok(fragment) = decode_fragment(fragment) else {
                            continue;
                        };
                        if let Ok(target) = archive_href(
                            &local_folder,
                            if file.is_empty() {
                                name.rsplit('/').next().unwrap_or("")
                            } else {
                                file
                            },
                        ) {
                            links.push(json!({"paraIndex":para.unwrap_or(0),"label":safe_text(element),"target":format!("{target}#{fragment}"),"footnote":element.value().attr("epub:type").is_some_and(|s|s.split_whitespace().any(|s|s=="noteref"))}));
                        }
                    }
                }
            }
            if element.value().name() == "img" && chapter_index.is_some() {
                if let Some(src) = element.value().attr("src") {
                    if let Ok(asset) = archive_href(&local_folder, src) {
                        if !assets.contains_key(&asset) {
                            let bytes = read(&mut zip, &asset, &mut budget)?;
                            if bytes.len() > 8 * 1024 * 1024 {
                                return Err("epub_image_limit".into());
                            }
                            let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
                                .with_guessed_format()
                                .map_err(|_| "invalid_epub_image")?;
                            let mut limits = image::Limits::default();
                            limits.max_image_width = Some(8192);
                            limits.max_image_height = Some(8192);
                            limits.max_alloc = Some(64 * 1024 * 1024);
                            reader.limits(limits);
                            // One unsupported/broken asset must not suppress valid
                            // images and footnotes from the rest of this chapter.
                            let Ok(image) = reader.decode() else { continue };
                            let image = image.thumbnail(2048, 2048);
                            let mut png = std::io::Cursor::new(Vec::new());
                            image
                                .write_to(&mut png, image::ImageFormat::Png)
                                .map_err(|_| "invalid_epub_image")?;
                            image_bytes += png.get_ref().len();
                            if image_bytes > 32 * 1024 * 1024 {
                                return Err("epub_image_limit".into());
                            }
                            assets.insert(
                                asset.clone(),
                                format!(
                                    "data:image/png;base64,{}",
                                    base64::engine::general_purpose::STANDARD
                                        .encode(png.into_inner())
                                ),
                            );
                        }
                        // The image is outside paragraph text, preserving UTF-16 offsets.
                        rendered_image_bytes = rendered_image_bytes
                            .checked_add(assets[&asset].len())
                            .ok_or("epub_image_limit")?;
                        if rendered_image_bytes > 48 * 1024 * 1024 {
                            return Err("epub_image_limit".into());
                        }
                        let before = document
                            .select(&all)
                            .take_while(|e| e.id() != element.id())
                            .filter(|e| paragraph_nodes.iter().any(|p| p.id() == e.id()))
                            .count();
                        images.push(json!({"beforeParagraph":para.unwrap_or(before),"src":assets[&asset],"alt":element.value().attr("alt").unwrap_or("")}));
                    }
                }
            }
        }
        if let Some(index) = chapter_index {
            let mut chapter = book["chapters"][index].clone();
            chapter["images"] = images.into();
            chapter["links"] = links.into();
            chapters.push(chapter);
        }
    }
    Ok(json!({"version":1,"chapters":chapters,"targets":targets}))
}
fn epub(path: &Path) -> Result<Value> {
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 20_000 {
        return Err("archive_entry_limit".into());
    }
    let mut budget = 128 * 1024 * 1024u64;
    let mut read = |name: &str| -> Result<String> {
        if Path::new(name).components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) || name.contains('\\')
        {
            return Err("invalid_archive_path".into());
        }
        let bytes = read_limited(
            zip.by_name(name).map_err(|e| e.to_string())?,
            MAX_TEXT.min(budget),
        )?;
        budget = budget
            .checked_sub(bytes.len() as u64)
            .ok_or("archive_size_limit")?;
        Ok(decode(&bytes))
    };
    let container = xml_elements(&read("META-INF/container.xml")?)?;
    let opf = container
        .iter()
        .find(|n| n.name == "rootfile")
        .and_then(|n| n.attrs.get("full-path"))
        .ok_or("epub_root_missing")?;
    let package = xml_elements(&read(opf)?)?;
    let folder = opf
        .rsplit_once('/')
        .map(|(d, _)| format!("{d}/"))
        .unwrap_or_default();
    let title = package
        .iter()
        .find(|n| n.name == "title")
        .map(|n| n.text.as_str())
        .unwrap_or("书籍");
    let author = package
        .iter()
        .filter(|n| n.name == "creator")
        .map(|n| n.text.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let manifest: BTreeMap<_, _> = package
        .iter()
        .filter(|n| n.name == "item")
        .filter_map(|n| Some((n.attrs.get("id")?, n.attrs.get("href")?)))
        .collect();
    let mut chapters = Vec::new();
    let mut targets = BTreeMap::new();
    for item in package.iter().filter(|n| n.name == "itemref") {
        let id = item.attrs.get("idref").ok_or("epub_spine_id_missing")?;
        let href = manifest.get(id).ok_or("epub_spine_target_missing")?;
        let chapter_path = archive_href(&folder, href)?;
        let html = read(&chapter_path)?;
        let document = Html::parse_document(&html);
        let blocks = Selector::parse("h1,h2,h3,h4,p,li,blockquote,pre").unwrap();
        let mut paragraphs = Vec::new();
        let mut chapter_title = None;
        for element in document.select(&blocks) {
            let text = element
                .descendants()
                .filter_map(|n| n.value().as_text().map(|t| (n, t)))
                .filter(|(n, _)| {
                    !n.ancestors().any(|a| {
                        a.value()
                            .as_element()
                            .is_some_and(|e| ["script", "style"].contains(&e.name()))
                    })
                })
                .map(|(_, t)| t.to_string())
                .collect::<String>();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                continue;
            }
            if chapter_title.is_none() && element.value().name().starts_with('h') {
                chapter_title = Some(text.clone());
            }
            if element.select(&blocks).count() == 0 {
                let chapter_id = format!("chapter-{}", chapters.len() + 1);
                for node in std::iter::once(element)
                    .chain(element.ancestors().filter_map(scraper::ElementRef::wrap))
                {
                    if let Some(fragment) = node.value().attr("id") {
                        targets
                            .entry(format!("{chapter_path}#{fragment}"))
                            .or_insert_with(
                                || json!({"chapterId":chapter_id,"paraIndex":paragraphs.len()}),
                            );
                    }
                }
                paragraphs.push(text);
            }
        }
        if paragraphs.is_empty() {
            if document
                .select(&Selector::parse("img,image").unwrap())
                .next()
                .is_some()
            {
                paragraphs.push(String::new());
            } else {
                return Err("empty_epub_chapter".into());
            }
        }
        chapters.push(json!({"id":format!("chapter-{}",chapters.len()+1),"title":chapter_title.unwrap_or_else(||format!("第 {} 章",chapters.len()+1)),"paragraphs":paragraphs}));
        targets.insert(
            chapter_path,
            json!({"chapterId":chapters.last().unwrap()["id"],"paraIndex":0}),
        );
    }
    if chapters.is_empty() {
        return Err("empty_epub_spine".into());
    }
    let mut metadata = json!({"version":1});
    for (source, key, limit) in [
        ("publisher", "publisher", 255),
        ("description", "description", 20000),
        ("rights", "rights", 2000),
    ] {
        if let Some(node) = package
            .iter()
            .find(|n| n.name == source && n.path.contains("/metadata/"))
        {
            metadata[key] = node
                .text
                .trim()
                .chars()
                .take(limit)
                .collect::<String>()
                .into();
        }
    }
    let languages: Vec<_> = package
        .iter()
        .filter(|n| n.name == "language" && n.path.contains("/metadata/"))
        .map(|n| n.text.trim())
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .take(32)
        .collect();
    if !languages.is_empty() {
        metadata["languages"] = languages.into();
    }
    let subjects: Vec<_> = package
        .iter()
        .filter(|n| n.name == "subject" && n.path.contains("/metadata/"))
        .map(|n| n.text.trim().chars().take(64).collect::<String>())
        .filter(|s| !s.is_empty())
        .take(32)
        .collect();
    if !subjects.is_empty() {
        metadata["subjects"] = subjects.into();
    }
    let identifiers:Vec<_>=package.iter().filter(|n|n.name=="identifier" && n.path.contains("/metadata/")).filter_map(|n|{let value=n.text.trim();if value.is_empty(){return None;}let scheme=n.attrs.get("opf:scheme").or_else(||n.attrs.get("scheme")).map(String::as_str).unwrap_or(if value.starts_with("urn:isbn:"){"ISBN"}else{"EPUB"});Some(json!({"scheme":if scheme.eq_ignore_ascii_case("isbn"){"ISBN"}else{scheme},"value":value.trim_start_matches("urn:isbn:").chars().take(255).collect::<String>()}))}).take(32).collect();
    if !identifiers.is_empty() {
        metadata["identifiers"] = identifiers.into();
    }
    metadata["contributors"] = package
        .iter()
        .filter(|n| n.name == "creator" && n.path.contains("/metadata/"))
        .map(
            |n| json!({"name":n.text.trim().chars().take(255).collect::<String>(),"role":"author"}),
        )
        .take(64)
        .collect::<Vec<_>>()
        .into();
    if let Some(date) = package
        .iter()
        .find(|n| n.name == "date" && n.path.contains("/metadata/"))
    {
        let value = date.text.trim().split('T').next().unwrap_or("");
        if [4, 7, 10].contains(&value.len())
            && value.chars().all(|c| c.is_ascii_digit() || c == '-')
        {
            metadata["publishedDate"] = value.into();
        }
    }
    let mut navigation = Vec::new();
    if let Some(nav) = package.iter().find(|n| {
        n.name == "item"
            && n.attrs
                .get("properties")
                .is_some_and(|s| s.split_whitespace().any(|p| p == "nav"))
    }) {
        if let Some(href) = nav.attrs.get("href") {
            let path = archive_href(&folder, href)?;
            let nav_folder = path
                .rsplit_once('/')
                .map_or(String::new(), |(d, _)| format!("{d}/"));
            let document = Html::parse_document(&read(&path)?);
            for nav in document
                .select(&Selector::parse("nav").unwrap())
                .filter(|n| {
                    n.value()
                        .attr("epub:type")
                        .is_some_and(|s| s.split_whitespace().any(|s| s == "toc"))
                        || n.value().attr("role") == Some("doc-toc")
                })
            {
                for link in nav.select(&Selector::parse("a[href]").unwrap()).take(10000) {
                    let href = link.value().attr("href").unwrap();
                    let (file, fragment) = href.split_once('#').unwrap_or((href, ""));
                    let Ok(fragment) = decode_fragment(fragment) else {
                        continue;
                    };
                    let path = archive_href(&nav_folder, file);
                    let Ok(path) = path else { continue };
                    let key = if fragment.is_empty() {
                        path
                    } else {
                        format!("{path}#{fragment}")
                    };
                    if let Some(target) = targets.get(&key) {
                        let label = safe_text(link).chars().take(255).collect::<String>();
                        if label.is_empty() {
                            continue;
                        }
                        let depth = link
                            .ancestors()
                            .filter(|n| n.value().as_element().is_some_and(|e| e.name() == "li"))
                            .count()
                            .clamp(1, 3);
                        navigation.push(json!({"id":format!("epub-nav:{}",navigation.len()),"title":label,"chapterId":target["chapterId"],"paraIndex":target["paraIndex"],"depth":depth}));
                    }
                }
            }
        }
    }
    // EPUB 2 uses NCX instead of an EPUB 3 navigation document.
    if navigation.is_empty() {
        let toc_id = package
            .iter()
            .find(|n| n.name == "spine")
            .and_then(|n| n.attrs.get("toc"));
        if let Some(ncx) = package.iter().find(|n| {
            n.name == "item"
                && (toc_id.is_some_and(|id| n.attrs.get("id") == Some(id))
                    || n.attrs
                        .get("media-type")
                        .is_some_and(|s| s == "application/x-dtbncx+xml"))
        }) {
            if let Some(href) = ncx.attrs.get("href") {
                let path = archive_href(&folder, href)?;
                let nav_folder = path
                    .rsplit_once('/')
                    .map_or(String::new(), |(d, _)| format!("{d}/"));
                let document = Html::parse_document(&read(&path)?);
                let labels = Selector::parse("navlabel").unwrap();
                let contents = Selector::parse("content[src]").unwrap();
                for point in document
                    .select(&Selector::parse("navpoint").unwrap())
                    .take(10000)
                {
                    let Some(label) = point.select(&labels).next() else {
                        continue;
                    };
                    let Some(content) = point.select(&contents).next() else {
                        continue;
                    };
                    let href = content.value().attr("src").unwrap();
                    let (file, fragment) = href.split_once('#').unwrap_or((href, ""));
                    let Ok(fragment) = decode_fragment(fragment) else {
                        continue;
                    };
                    let Ok(path) = archive_href(&nav_folder, file) else {
                        continue;
                    };
                    let key = if fragment.is_empty() {
                        path
                    } else {
                        format!("{path}#{fragment}")
                    };
                    if let Some(target) = targets.get(&key) {
                        let label = safe_text(label).chars().take(255).collect::<String>();
                        if label.is_empty() {
                            continue;
                        }
                        let depth = (1 + point
                            .ancestors()
                            .filter(|n| {
                                n.value()
                                    .as_element()
                                    .is_some_and(|e| e.name() == "navpoint")
                            })
                            .count())
                        .clamp(1, 3);
                        navigation.push(json!({"id":format!("epub-nav:{}",navigation.len()),"title":label,"chapterId":target["chapterId"],"paraIndex":target["paraIndex"],"depth":depth}));
                    }
                }
            }
        }
    }
    let mut output = json!({"title":title,"author":author,"metadata":metadata,"chapters":chapters});
    if !navigation.is_empty() {
        let mut outline = Vec::new();
        for chapter in &chapters {
            outline.push(json!({"id":format!("chapter:{}",chapter["id"].as_str().unwrap()),"title":chapter["title"],"chapterId":chapter["id"],"depth":0}));
            let mut depth = 0usize;
            for entry in navigation
                .iter()
                .filter(|v| v["chapterId"] == chapter["id"])
            {
                let mut entry = entry.clone();
                depth = (entry["depth"].as_u64().unwrap() as usize).min(depth + 1);
                entry["depth"] = depth.into();
                outline.push(entry);
            }
        }
        output["outline"] = outline.into();
    }
    Ok(output)
}
