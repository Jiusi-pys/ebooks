//! PDFium is a separately distributed, pinned native infrastructure dependency.
//! Calls are serialized because the PDFium C API is not thread safe.
use libloading::{Library, Symbol};
use serde_json::{json, Value};
use std::{
    ffi::{c_int, c_void},
    path::Path,
    sync::Mutex,
};
type Handle = *mut c_void;
static PDF_LOCK: Mutex<()> = Mutex::new(());

pub fn parse(path: &Path) -> Result<Value, String> {
    let _guard = PDF_LOCK.lock().map_err(|_| "pdf_lock_failed")?;
    let library = super::dependency_path("pdfium.dll", "SHUFANG_PDFIUM")?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    // All symbols use PDFium's documented C ABI; handles are closed before
    // their owning document/library, and input bytes outlive the document.
    unsafe {
        let lib = Library::new(library).map_err(|e| format!("pdfium_unavailable: {e}"))?;
        macro_rules! sym {
            ($name:literal,$ty:ty) => {{
                let f: Symbol<$ty> = lib
                    .get(concat!($name, "\0").as_bytes())
                    .map_err(|e| e.to_string())?;
                *f
            }};
        }
        let init = sym!("FPDF_InitLibrary", unsafe extern "C" fn());
        let destroy = sym!("FPDF_DestroyLibrary", unsafe extern "C" fn());
        let load = sym!(
            "FPDF_LoadMemDocument64",
            unsafe extern "C" fn(*const c_void, usize, *const i8) -> Handle
        );
        let close = sym!("FPDF_CloseDocument", unsafe extern "C" fn(Handle));
        let count = sym!("FPDF_GetPageCount", unsafe extern "C" fn(Handle) -> c_int);
        let page = sym!(
            "FPDF_LoadPage",
            unsafe extern "C" fn(Handle, c_int) -> Handle
        );
        let close_page = sym!("FPDF_ClosePage", unsafe extern "C" fn(Handle));
        let text_page = sym!("FPDFText_LoadPage", unsafe extern "C" fn(Handle) -> Handle);
        let close_text = sym!("FPDFText_ClosePage", unsafe extern "C" fn(Handle));
        let text_count = sym!("FPDFText_CountChars", unsafe extern "C" fn(Handle) -> c_int);
        let get_text = sym!(
            "FPDFText_GetText",
            unsafe extern "C" fn(Handle, c_int, c_int, *mut u16) -> c_int
        );
        init();
        let doc = load(bytes.as_ptr().cast(), bytes.len(), std::ptr::null());
        if doc.is_null() {
            destroy();
            return Err("invalid_or_encrypted_pdf".into());
        }
        let result = (|| {
            let pages = count(doc);
            if !(1..=20_000).contains(&pages) {
                return Err("pdf_page_limit".into());
            }
            let mut chapters = Vec::new();
            let mut budget = 16_000_000usize;
            for index in 0..pages {
                let p = page(doc, index);
                if p.is_null() {
                    return Err("pdf_page_failed".into());
                }
                let t = text_page(p);
                if t.is_null() {
                    close_page(p);
                    return Err("pdf_text_failed".into());
                }
                let n = text_count(t);
                if n < 0 || n as usize > budget {
                    close_text(t);
                    close_page(p);
                    return Err("pdf_text_limit".into());
                }
                budget -= n as usize;
                let mut buffer = vec![0u16; n as usize + 1];
                let read = get_text(t, 0, n, buffer.as_mut_ptr());
                close_text(t);
                close_page(p);
                if read < 0 || read as usize > buffer.len() {
                    return Err("pdf_text_failed".into());
                }
                let text = String::from_utf16_lossy(&buffer[..read.saturating_sub(1) as usize]);
                let paragraphs: Vec<_> = text
                    .lines()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                chapters.push(json!({"id":format!("page-{}",index+1),"title":format!("第 {} 页",index+1),"paragraphs":paragraphs}));
            }
            Ok(
                json!({"title":path.file_stem().and_then(|s|s.to_str()).unwrap_or("PDF"),"author":"","chapters":chapters,"pageCount":pages,"readerMode":"original"}),
            )
        })();
        close(doc);
        destroy();
        result
    }
}
