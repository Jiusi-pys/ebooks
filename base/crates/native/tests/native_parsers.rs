use shufang_native::books;

#[test]
#[ignore = "requires packaged PDFium native dependency"]
fn pdfium_reads_a_real_pdf_document() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.pdf");
    let content = "BT /F1 12 Tf 40 100 Td (Hello native PDF) Tj ET";
    let objects=["<< /Type /Catalog /Pages 2 0 R >>".to_string(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),format!("<< /Length {} >>\nstream\n{content}\nendstream",content.len())];
    let mut pdf = "%PDF-1.4\n".to_owned();
    let mut positions = vec![0];
    for (i, object) in objects.iter().enumerate() {
        positions.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, object));
    }
    let offset = pdf.len();
    pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
    for p in positions.iter().skip(1) {
        pdf.push_str(&format!("{p:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{offset}\n%%EOF\n"
    ));
    std::fs::write(&path, pdf).unwrap();
    let book = books::parse(&path).unwrap();
    assert_eq!(book["pageCount"], 1);
    assert!(book.to_string().contains("Hello native PDF"));
}

#[test]
#[ignore = "requires packaged mobitool and upstream fixture checkout"]
fn kindle_converter_reads_the_upstream_ncx_sample() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.tools/native/libmobi/tests/samples/sample-ncx.mobi");
    let book = books::parse(&path).unwrap();
    assert!(!book["chapters"].as_array().unwrap().is_empty());
}
