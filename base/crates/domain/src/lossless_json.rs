//! Standard JSON with JavaScript strings/numbers. Arena storage avoids recursive
//! parsing, serialization and destruction of publisher-supplied deep documents.
#[derive(Clone, Debug)]
enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<usize>),
    Object(Vec<(Vec<u16>, usize)>),
}
#[derive(Clone, Debug)]
pub struct Json {
    nodes: std::sync::Arc<Vec<Node>>,
    root: usize,
}
#[derive(Clone, Copy)]
pub struct View<'a> {
    json: &'a Json,
    index: usize,
}
impl View<'_> {
    pub fn to_owned(&self) -> Json {
        Json {
            nodes: self.json.nodes.clone(),
            root: self.index,
        }
    }
    pub fn string_units(&self) -> Option<&[u16]> {
        match &self.json.nodes[self.index] {
            Node::String(v) => Some(v),
            _ => None,
        }
    }
    pub fn number(&self) -> Option<f64> {
        match self.json.nodes[self.index] {
            Node::Number(v) => Some(v),
            _ => None,
        }
    }
    pub fn get_units(&self, key: &[u16]) -> Option<View<'_>> {
        match &self.json.nodes[self.index] {
            Node::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, index)| View {
                json: self.json,
                index: *index,
            }),
            _ => None,
        }
    }
}
impl PartialEq for Json {
    fn eq(&self, other: &Self) -> bool {
        self.stringify(true) == other.stringify(true)
    }
}
enum Frame {
    Array {
        items: Vec<usize>,
        state: u8,
    },
    Object {
        items: Vec<(Vec<u16>, usize)>,
        positions: std::collections::BTreeMap<Vec<u16>, usize>,
        key: Vec<u16>,
        state: u8,
    },
}
struct Parser<'a> {
    text: &'a str,
    pos: usize,
    nodes: Vec<Node>,
    frames: Vec<Frame>,
    root: Option<usize>,
}
type Result<T> = std::result::Result<T, String>;
impl Json {
    pub fn from_entries(entries: Vec<(Vec<u16>, Json)>) -> Result<Self> {
        Self::parse(&format!(
            "{{{}}}",
            entries
                .into_iter()
                .map(|(key, value)| format!("{}:{}", quote_units(&key), value.stringify(false)))
                .collect::<Vec<_>>()
                .join(",")
        ))
    }
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 256 * 1024 * 1024 {
            return Err("json_too_large".into());
        }
        let mut p = Parser {
            text,
            pos: 0,
            nodes: vec![],
            frames: vec![],
            root: None,
        };
        loop {
            p.space();
            if p.frames.is_empty() {
                if let Some(root) = p.root {
                    if p.pos != text.len() {
                        return Err("invalid_json".into());
                    }
                    return Ok(Self {
                        nodes: std::sync::Arc::new(p.nodes),
                        root,
                    });
                }
                p.value()?;
                continue;
            }
            let action = match p.frames.last().unwrap() {
                Frame::Array { state, .. } => match state {
                    0 => {
                        if p.peek() == Some(b']') {
                            0
                        } else {
                            1
                        }
                    }
                    1 => 1,
                    _ => 2,
                },
                Frame::Object { state, .. } => match state {
                    0 => {
                        if p.peek() == Some(b'}') {
                            0
                        } else {
                            3
                        }
                    }
                    1 => 3,
                    2 => 4,
                    3 => 1,
                    _ => 2,
                },
            };
            match action {
                0 => p.close()?,
                1 => p.value()?,
                2 => match p.peek() {
                    Some(b',') => {
                        p.pos += 1;
                        match p.frames.last_mut().unwrap() {
                            Frame::Array { state, .. } | Frame::Object { state, .. } => *state = 1,
                        }
                    }
                    Some(b']') if matches!(p.frames.last(), Some(Frame::Array { .. })) => {
                        p.close()?
                    }
                    Some(b'}') if matches!(p.frames.last(), Some(Frame::Object { .. })) => {
                        p.close()?
                    }
                    _ => return Err("invalid_json".into()),
                },
                3 => {
                    let key = p.string()?;
                    if let Frame::Object {
                        key: slot, state, ..
                    } = p.frames.last_mut().unwrap()
                    {
                        *slot = key;
                        *state = 2;
                    }
                }
                _ => {
                    if p.peek() != Some(b':') {
                        return Err("invalid_json".into());
                    }
                    p.pos += 1;
                    if let Frame::Object { state, .. } = p.frames.last_mut().unwrap() {
                        *state = 3;
                    }
                }
            }
        }
    }
    pub fn get(&self, key: &str) -> Option<View<'_>> {
        self.get_units(&key.encode_utf16().collect::<Vec<_>>())
    }
    pub fn string_units(&self) -> Option<&[u16]> {
        match &self.nodes[self.root] {
            Node::String(v) => Some(v),
            _ => None,
        }
    }
    pub fn boolean(&self) -> Option<bool> {
        match self.nodes[self.root] {
            Node::Bool(v) => Some(v),
            _ => None,
        }
    }
    pub fn number(&self) -> Option<f64> {
        match self.nodes[self.root] {
            Node::Number(n) => Some(n),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self.nodes[self.root], Node::Null)
    }
    pub fn entries(&self) -> Option<Vec<(Vec<u16>, Json)>> {
        match &self.nodes[self.root] {
            Node::Object(items) => Some(
                items
                    .iter()
                    .map(|(key, index)| {
                        (
                            key.clone(),
                            Json {
                                nodes: self.nodes.clone(),
                                root: *index,
                            },
                        )
                    })
                    .collect(),
            ),
            _ => None,
        }
    }
    pub fn elements(&self) -> Option<Vec<Json>> {
        match &self.nodes[self.root] {
            Node::Array(items) => Some(
                items
                    .iter()
                    .map(|index| Json {
                        nodes: self.nodes.clone(),
                        root: *index,
                    })
                    .collect(),
            ),
            _ => None,
        }
    }
    pub fn truthy(&self) -> bool {
        match &self.nodes[self.root] {
            Node::Null => false,
            Node::Bool(v) => *v,
            Node::Number(v) => *v != 0.0 && !v.is_nan(),
            Node::String(v) => !v.is_empty(),
            _ => true,
        }
    }
    pub fn has_only_finite_numbers(&self) -> bool {
        let mut remaining = vec![self.root];
        while let Some(index) = remaining.pop() {
            match &self.nodes[index] {
                Node::Number(n) if !n.is_finite() => return false,
                Node::Array(items) => remaining.extend(items),
                Node::Object(items) => remaining.extend(items.iter().map(|(_, index)| index)),
                _ => (),
            }
        }
        true
    }
    pub fn get_units(&self, key: &[u16]) -> Option<View<'_>> {
        match &self.nodes[self.root] {
            Node::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, index)| View {
                json: self,
                index: *index,
            }),
            _ => None,
        }
    }
    pub fn stringify(&self, canonical: bool) -> String {
        self.stringify_index(self.root, canonical)
    }
    fn stringify_index(&self, index: usize, canonical: bool) -> String {
        enum Work<'a> {
            Node(usize),
            Literal(&'static str),
            Key(&'a [u16]),
        }
        let mut out = String::new();
        let mut work = vec![Work::Node(index)];
        while let Some(task) = work.pop() {
            match task {
                Work::Literal(s) => out.push_str(s),
                Work::Key(s) => quote(s, &mut out),
                Work::Node(i) => match &self.nodes[i] {
                    Node::Null => out.push_str("null"),
                    Node::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    Node::Number(n) => {
                        if n.is_finite() {
                            out.push_str(ryu_js::Buffer::new().format(*n));
                        } else {
                            out.push_str("null");
                        }
                    }
                    Node::String(s) => quote(s, &mut out),
                    Node::Array(items) => {
                        out.push('[');
                        work.push(Work::Literal("]"));
                        for (position, index) in items.iter().enumerate().rev() {
                            work.push(Work::Node(*index));
                            if position > 0 {
                                work.push(Work::Literal(","));
                            }
                        }
                    }
                    Node::Object(items) => {
                        let mut ordered: Vec<_> = items.iter().collect();
                        if canonical {
                            ordered.sort_by(|a, b| a.0.cmp(&b.0));
                        }
                        out.push('{');
                        work.push(Work::Literal("}"));
                        for (position, (key, index)) in ordered.into_iter().enumerate().rev() {
                            work.push(Work::Node(*index));
                            work.push(Work::Literal(":"));
                            work.push(Work::Key(key));
                            if position > 0 {
                                work.push(Work::Literal(","));
                            }
                        }
                    }
                },
            }
        }
        out
    }
}
pub fn quote_units(units: &[u16]) -> String {
    let mut result = String::new();
    quote(units, &mut result);
    result
}
impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }
    fn space(&mut self) {
        while self.peek().is_some_and(|b| b" \r\n\t".contains(&b)) {
            self.pos += 1;
        }
    }
    fn attach(&mut self, node: Node) -> Result<()> {
        let index = self.nodes.len();
        self.nodes.push(node);
        match self.frames.last_mut() {
            None => self.root = Some(index),
            Some(Frame::Array { items, state }) => {
                items.push(index);
                *state = 2;
            }
            Some(Frame::Object {
                items,
                positions,
                key,
                state,
            }) => {
                if *state != 3 {
                    return Err("invalid_json".into());
                }
                if let Some(position) = positions.get(key) {
                    items[*position].1 = index;
                } else {
                    positions.insert(key.clone(), items.len());
                    items.push((std::mem::take(key), index));
                }
                *state = 4;
            }
        }
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        self.pos += 1;
        let node = match self.frames.pop().unwrap() {
            Frame::Array { items, .. } => Node::Array(items),
            Frame::Object { items, .. } => Node::Object(items),
        };
        self.attach(node)
    }
    fn value(&mut self) -> Result<()> {
        match self.peek() {
            Some(b'[') => {
                self.pos += 1;
                self.frames.push(Frame::Array {
                    items: vec![],
                    state: 0,
                });
                Ok(())
            }
            Some(b'{') => {
                self.pos += 1;
                self.frames.push(Frame::Object {
                    items: vec![],
                    positions: Default::default(),
                    key: vec![],
                    state: 0,
                });
                Ok(())
            }
            Some(b'"') => {
                let s = self.string()?;
                self.attach(Node::String(s))
            }
            Some(b't') => {
                self.word("true")?;
                self.attach(Node::Bool(true))
            }
            Some(b'f') => {
                self.word("false")?;
                self.attach(Node::Bool(false))
            }
            Some(b'n') => {
                self.word("null")?;
                self.attach(Node::Null)
            }
            Some(b'-' | b'0'..=b'9') => {
                let n = self.number()?;
                self.attach(Node::Number(n))
            }
            _ => Err("invalid_json".into()),
        }
    }
    fn word(&mut self, word: &str) -> Result<()> {
        if !self.text[self.pos..].starts_with(word) {
            return Err("invalid_json".into());
        }
        self.pos += word.len();
        Ok(())
    }
    fn number(&mut self) -> Result<f64> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err("invalid_json".into()),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            let before = self.pos;
            self.digits();
            if before == self.pos {
                return Err("invalid_json".into());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            let before = self.pos;
            self.digits();
            if before == self.pos {
                return Err("invalid_json".into());
            }
        }
        self.text[start..self.pos]
            .parse()
            .map_err(|_| "invalid_json".into())
    }
    fn digits(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
    }
    fn string(&mut self) -> Result<Vec<u16>> {
        if self.peek() != Some(b'"') {
            return Err("invalid_json".into());
        }
        self.pos += 1;
        let mut units = vec![];
        loop {
            match self.peek() {
                None => return Err("invalid_json".into()),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(units);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = self.peek().ok_or("invalid_json")?;
                    self.pos += 1;
                    let unit = match escape {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let end = self.pos.checked_add(4).ok_or("invalid_json")?;
                            let hex = self
                                .text
                                .as_bytes()
                                .get(self.pos..end)
                                .ok_or("invalid_json")?;
                            let mut n = 0u16;
                            for b in hex {
                                n = n * 16
                                    + match b {
                                        b'0'..=b'9' => (*b - b'0') as u16,
                                        b'a'..=b'f' => (*b - b'a' + 10) as u16,
                                        b'A'..=b'F' => (*b - b'A' + 10) as u16,
                                        _ => return Err("invalid_json".into()),
                                    };
                            }
                            self.pos = end;
                            n
                        }
                        _ => return Err("invalid_json".into()),
                    };
                    units.push(unit);
                }
                Some(0..=31) => return Err("invalid_json".into()),
                _ => {
                    let ch = self.text[self.pos..].chars().next().ok_or("invalid_json")?;
                    let mut buffer = [0; 2];
                    units.extend_from_slice(ch.encode_utf16(&mut buffer));
                    self.pos += ch.len_utf8();
                }
            }
        }
    }
}
fn quote(units: &[u16], out: &mut String) {
    out.push('"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        match unit {
            34 => out.push_str("\\\""),
            92 => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            12 => out.push_str("\\f"),
            10 => out.push_str("\\n"),
            13 => out.push_str("\\r"),
            9 => out.push_str("\\t"),
            0..=31 => out.push_str(&format!("\\u{unit:04x}")),
            0xd800..=0xdbff if index < units.len() && (0xdc00..=0xdfff).contains(&units[index]) => {
                let low = units[index];
                index += 1;
                out.push(
                    char::from_u32(
                        0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00),
                    )
                    .unwrap(),
                );
            }
            0xd800..=0xdfff => out.push_str(&format!("\\u{unit:04x}")),
            _ => out.push(char::from_u32(unit as u32).unwrap()),
        }
    }
    out.push('"');
}
