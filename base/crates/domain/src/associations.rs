use serde_json::{json, Value};
type Result<T> = std::result::Result<T, String>;
pub fn encode_uri_component(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub fn anchor_key(v: &Value) -> Result<String> {
    let kind = v["kind"].as_str().ok_or("invalid_anchor_kind")?;
    let parts = match kind {
        "text" => json!([
            "text",
            v["bookId"],
            v["chapterId"],
            v["paraIndex"],
            v["start"],
            v["end"]
        ]),
        "pdf" => {
            let mut rects: Vec<Vec<f64>> = v["pdfAnchor"]["rects"]
                .as_array()
                .ok_or("invalid_pdf_anchor")?
                .iter()
                .map(|r| {
                    ["x", "y", "width", "height"]
                        .iter()
                        .map(|k| {
                            r[k].as_f64()
                                .filter(|f| f.is_finite())
                                .map(|f| (f * 1_000_000.0).round() / 1_000_000.0)
                                .ok_or("invalid_pdf_anchor".to_string())
                        })
                        .collect()
                })
                .collect::<Result<_>>()?;
            rects.sort_by(|a, b| {
                a.iter()
                    .zip(b)
                    .map(|(a, b)| a.total_cmp(b))
                    .find(|o| !o.is_eq())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let rects: Vec<Vec<Value>> = rects
                .iter()
                .map(|r| {
                    r.iter()
                        .map(|f| {
                            serde_json::from_str(&format!("{}", if *f == 0.0 { 0.0 } else { *f }))
                                .unwrap()
                        })
                        .collect()
                })
                .collect();
            json!(["pdf", v["bookId"], v["pdfAnchor"]["page"], rects])
        }
        _ => return Err("invalid_anchor_kind".into()),
    };
    Ok(format!(
        "{kind}:{}",
        encode_uri_component(&parts.to_string())
    ))
}
pub fn pair_key(source: &Value, target: &Value, direction: &str) -> Result<String> {
    if !["bidirectional", "source-to-target"].contains(&direction) {
        return Err("invalid_direction".into());
    }
    let mut pair = [anchor_key(source)?, anchor_key(target)?];
    if pair[0] == pair[1] {
        return Err("identical_association_endpoints".into());
    }
    if direction == "bidirectional" {
        pair.sort();
    }
    Ok(format!(
        "{direction}:{}",
        encode_uri_component(&json!(pair).to_string())
    ))
}
