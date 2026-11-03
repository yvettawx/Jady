//! 网页链接收集 (A13): a page's title and text from an address. Reaches only the public web: a
//! link in a note must not be able to read this machine or the local network.

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use crate::IoError;

const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebPage {
    pub title: Option<String>,
    pub text: String,
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_unspecified()
                || v.octets()[0] == 100 && (v.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v) => {
            let s = v.segments()[0];
            !(v.is_loopback()
                || v.is_unspecified()
                || (s & 0xfe00) == 0xfc00
                || (s & 0xffc0) == 0xfe80
                || v.to_ipv4_mapped()
                    .is_some_and(|m| !is_public(IpAddr::V4(m))))
        }
    }
}

/// Whether an address is http(s) on a public host, judged by what its name resolves to.
pub fn public_url(url: &str) -> Result<(), IoError> {
    let bad = |why: &str| IoError::Read(why.to_owned());
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| bad("only http and https"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let with_port = if host_port.contains(':') && !host_port.ends_with(']') {
        host_port.to_owned()
    } else {
        format!("{host_port}:443")
    };
    let addrs: Vec<_> = with_port
        .to_socket_addrs()
        .map_err(|_| bad("cannot find that address"))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(bad("not a public address"));
    }
    Ok(())
}

pub fn fetch_page(url: &str) -> Result<WebPage, IoError> {
    let read = |e: &dyn std::fmt::Display| IoError::Read(e.to_string());
    public_url(url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        // A redirect could lead back to this machine, so none are followed blindly.
        .max_redirects(0)
        .build()
        .into();
    let mut at = url.to_owned();
    for _ in 0..5 {
        let mut response = agent.get(&at).call().map_err(|e| read(&e))?;
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| IoError::Read("bad redirect".into()))?;
            at = if next.starts_with("http") {
                next.to_owned()
            } else {
                let base = at.split('/').take(3).collect::<Vec<_>>().join("/");
                format!("{base}/{}", next.trim_start_matches('/'))
            };
            public_url(&at)?;
            continue;
        }
        let html = response
            .body_mut()
            .with_config()
            .limit(MAX_BYTES)
            .read_to_string()
            .map_err(|e| read(&e))?;
        return Ok(page_of(&html));
    }
    Err(IoError::Read("too many redirects".into()))
}

/// Good enough to find the page again by what it says; it is not a reader mode.
pub fn page_of(html: &str) -> WebPage {
    let lower = html.to_lowercase();
    let title = lower.find("<title").and_then(|start| {
        let open = lower[start..].find('>')? + start + 1;
        let close = lower[open..].find("</title")? + open;
        html.get(open..close).map(|t| decode(t.trim()))
    });
    let mut text = String::new();
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        text.push_str(&rest[..lt]);
        let tag = &rest[lt..];
        let low = tag.get(..8).unwrap_or(tag).to_lowercase();
        let skip_to = if low.starts_with("<script") {
            "</script>"
        } else if low.starts_with("<style") {
            "</style>"
        } else {
            ">"
        };
        let Some(end) = tag.to_lowercase().find(skip_to) else {
            rest = "";
            break;
        };
        // Lowercasing can change lengths outside ASCII; fall back to the end if it did.
        rest = tag.get(end + skip_to.len()..).unwrap_or("");
        text.push(' ');
    }
    text.push_str(rest);
    let lines: Vec<String> = decode(&text)
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    WebPage {
        title: title.filter(|t| !t.is_empty()),
        text: lines.join("\n"),
    }
}

fn decode(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_network_is_out_of_reach() {
        for url in [
            "http://127.0.0.1/",
            "http://localhost:8080/x",
            "http://192.168.1.1/",
            "http://10.0.0.1/",
            "http://[::1]:80/",
            "file:///etc/passwd",
            "http://169.254.169.254/latest",
        ] {
            assert!(public_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn title_and_text_without_scripts() {
        let p = page_of(
            "<html><head><title> 标题 &amp; 更多 </title><style>x{}</style></head>\
             <body><script>alert(1)</script><p>第一段</p>\n<p>第二段</p></body></html>",
        );
        assert_eq!(p.title.as_deref(), Some("标题 & 更多"));
        assert!(p.text.contains("第一段"));
        assert!(!p.text.contains("alert"));
        assert!(!p.text.contains("x{}"));
    }
}
