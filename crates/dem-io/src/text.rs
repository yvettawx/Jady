//! Text out of files (PRD A1, P1 step 10): so a slide deck or a PDF can be found by what it says.

use std::io::Read;
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::IoError;

/// The file's text by its extension; `None` for kinds that have none to read. A file that cannot be
/// read still gets kept by the caller: losing the text must not lose the file.
pub fn extract_text(path: &Path) -> Result<Option<String>, IoError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => pdf_text(path).map(Some),
        "pptx" => pptx_text(path).map(Some),
        "txt" | "md" | "markdown" => std::fs::read_to_string(path)
            .map(Some)
            .map_err(|e| IoError::Read(e.to_string())),
        _ => Ok(None),
    }
}

fn pdf_text(path: &Path) -> Result<String, IoError> {
    let bytes = std::fs::read(path).map_err(|e| IoError::Read(e.to_string()))?;
    // The parser panics on some malformed files; that only means no text for this one.
    std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes))
        .map_err(|_| IoError::Read("unreadable pdf".into()))?
        .map_err(|e| IoError::Read(e.to_string()))
}

/// Slides in order, one paragraph per line, a blank line between slides.
fn pptx_text(path: &Path) -> Result<String, IoError> {
    let read = |e: &dyn std::fmt::Display| IoError::Read(e.to_string());
    let file = std::fs::File::open(path).map_err(|e| read(&e))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| read(&e))?;
    let mut slides: Vec<(u32, String)> = zip
        .file_names()
        .filter_map(|n| {
            let n = n.ok()?;
            let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
            Some((num.parse().ok()?, n.to_string()))
        })
        .collect();
    slides.sort();
    let mut out = String::new();
    for (_, name) in slides {
        let mut xml = String::new();
        zip.by_name(&name)
            .map_err(|e| read(&e))?
            .read_to_string(&mut xml)
            .map_err(|e| read(&e))?;
        let lines = slide_lines(&xml);
        if !lines.is_empty() {
            out.push_str(&lines.join("\n"));
            out.push_str("\n\n");
        }
    }
    Ok(out.trim_end().to_owned())
}

fn slide_lines(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == "a:t" => in_text = true,
            Ok(Event::End(e)) if e.name().as_ref() == "a:t" => in_text = false,
            Ok(Event::End(e)) if e.name().as_ref() == "a:p" => {
                let done = std::mem::take(&mut line);
                if !done.trim().is_empty() {
                    lines.push(done);
                }
            }
            Ok(Event::Text(t)) if in_text => {
                line.push_str(&t);
            }
            Ok(Event::GeneralRef(r)) if in_text => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    line.push(c);
                } else {
                    match &*r {
                        "amp" => line.push('&'),
                        "lt" => line.push('<'),
                        "gt" => line.push('>'),
                        "quot" => line.push('"'),
                        "apos" => line.push('\''),
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn slides_come_out_in_order_with_their_paragraphs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.pptx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let slide = |t: &str| {
            format!(
                r#"<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>{t}</a:t></a:r></a:p><a:p><a:r><a:t>第二行 &amp; 更多</a:t></a:r></a:p></p:sld>"#
            )
        };
        for (name, text) in [("10", "第十张"), ("2", "第二张")] {
            zip.start_file::<_, ()>(
                format!("ppt/slides/slide{name}.xml"),
                zip::write::FileOptions::default(),
            )
            .unwrap();
            zip.write_all(slide(text).as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let text = extract_text(&path).unwrap().unwrap();
        assert_eq!(text, "第二张\n第二行 & 更多\n\n第十张\n第二行 & 更多");
    }

    #[test]
    fn kinds_without_text_and_broken_files() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, b"x").unwrap();
        assert_eq!(extract_text(&png).unwrap(), None);
        let pdf = dir.path().join("broken.pdf");
        std::fs::write(&pdf, b"not a pdf").unwrap();
        assert!(extract_text(&pdf).is_err());
    }
}
