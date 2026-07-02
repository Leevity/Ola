#!/usr/bin/env python3
"""Fetch a web page and extract readable content as clean Markdown.

Uses requests + BeautifulSoup + readability-lxml + html2text for lightweight,
fast extraction without a headless browser. Works well for articles, docs,
blogs, wikis, and most static websites.

Dependencies: pip install requests beautifulsoup4 readability-lxml html2text
"""

import sys
import argparse
import random
import time
from urllib.parse import urlparse


USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_1) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0",
]

BASE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}

ANTI_BOT_MARKERS = (
    "captcha",
    "verify you are human",
    "security verification",
    "access denied",
    "robot check",
    "访问过于频繁",
    "安全验证",
)


def build_headers(url: str):
    parsed = urlparse(url)
    scheme = parsed.scheme or "https"
    headers = dict(BASE_HEADERS)
    headers["User-Agent"] = random.choice(USER_AGENTS)

    if parsed.netloc:
        headers["Host"] = parsed.netloc
        origin = f"{scheme}://{parsed.netloc}"
        headers["Origin"] = origin
        headers["Referer"] = origin + "/"

    return headers


def is_anti_bot_response(html: str, status_code: int) -> bool:
    if status_code in (403, 429):
        return True

    snippet = html[:2000].lower()
    for marker in ANTI_BOT_MARKERS:
        if marker.lower() in snippet:
            return True

    return False


def try_cloudscraper(url: str, headers: dict, timeout: int):
    try:
        import cloudscraper
    except ImportError:
        return None

    scraper = cloudscraper.create_scraper(
        browser={
            "browser": "chrome",
            "platform": "windows",
            "mobile": False,
        }
    )

    try:
        resp = scraper.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
    except Exception:
        return None

    if resp.encoding and resp.encoding.lower() != 'utf-8':
        resp.encoding = resp.apparent_encoding or resp.encoding

    return resp.text, resp.url, resp.status_code


def setup_encoding():
    """Setup proper encoding for Windows console output."""
    if sys.platform == "win32":
        import io
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, io.UnsupportedOperation):
            sys.stdout = io.TextIOWrapper(
                sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True
            )
            sys.stderr = io.TextIOWrapper(
                sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True
            )


def check_dependencies():
    """Check that required packages are installed."""
    missing = []
    try:
        import requests  # noqa: F401
    except ImportError:
        missing.append("requests")
    try:
        from bs4 import BeautifulSoup  # noqa: F401
    except ImportError:
        missing.append("beautifulsoup4")
    try:
        from readability import Document  # noqa: F401
    except ImportError:
        missing.append("readability-lxml")
    try:
        import html2text  # noqa: F401
    except ImportError:
        missing.append("html2text")

    if missing:
        print(f"Error: missing dependencies: {', '.join(missing)}", file=sys.stderr)
        print(f"Install with: pip install {' '.join(missing)}", file=sys.stderr)
        sys.exit(1)


def fetch_url(url, timeout=30, max_attempts=3):
    """Fetch URL content, retrying through common anti-bot challenges."""
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    session = requests.Session()
    retry_strategy = Retry(
        total=0,
        connect=0,
        read=0,
        redirect=3,
        status=0,
        backoff_factor=0,
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    last_error = None

    for attempt in range(1, max_attempts + 1):
        try:
            resp = session.get(
                url,
                headers=build_headers(url),
                timeout=timeout,
                allow_redirects=True,
            )
        except requests.exceptions.Timeout as e:
            last_error = f"request timed out after {timeout}s"
            print(f"Warning: {last_error} (attempt {attempt}/{max_attempts})", file=sys.stderr)
            if attempt < max_attempts:
                time.sleep(min(2 ** attempt, 4))
            continue
        except requests.exceptions.ConnectionError as e:
            last_error = f"connection failed: {e}"
            print(f"Warning: {last_error} (attempt {attempt}/{max_attempts})", file=sys.stderr)
            if attempt < max_attempts:
                time.sleep(min(2 ** attempt, 4))
            continue

        if resp.encoding and resp.encoding.lower() != 'utf-8':
            resp.encoding = resp.apparent_encoding or resp.encoding
        html_text = resp.text

        anti_bot = is_anti_bot_response(html_text, resp.status_code)

        if not anti_bot and resp.status_code >= 400:
            try:
                resp.raise_for_status()
            except requests.exceptions.HTTPError as e:
                last_error = f"HTTP {resp.status_code}: {e}"
                break

        if not anti_bot:
            return html_text, resp.url, resp.status_code

        last_error = (
            f"Detected anti-bot response (status {resp.status_code})"
        )
        print(
            f"Warning: {last_error} - retrying with different headers (attempt {attempt}/{max_attempts})",
            file=sys.stderr,
        )
        if attempt < max_attempts:
            time.sleep(min(2 ** attempt, 4))

    # cloudscraper fallback for challenging sites
    scraper_result = try_cloudscraper(url, build_headers(url), timeout)
    if scraper_result:
        html, final_url, status = scraper_result
        if not is_anti_bot_response(html, status):
            return scraper_result

    error_message = last_error or "unable to fetch page"
    print(f"Error: {error_message}", file=sys.stderr)
    sys.exit(1)


def extract_with_readability(html, url):
    """Extract main article content using readability-lxml."""
    from readability import Document

    doc = Document(html, url=url)
    title = doc.short_title()
    content_html = doc.summary()
    return title, content_html


def extract_with_selector(html, selector):
    """Extract content matching a CSS selector."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    elements = soup.select(selector)
    if not elements:
        return None

    # Combine all matching elements
    parts = []
    for el in elements:
        parts.append(str(el))
    return "\n".join(parts)


def html_to_markdown(html, base_url=None):
    """Convert HTML to clean Markdown."""
    import html2text

    converter = html2text.HTML2Text()
    converter.body_width = 0  # Don't wrap lines
    converter.ignore_images = False
    converter.ignore_links = False
    converter.ignore_emphasis = False
    converter.protect_links = True
    converter.unicode_snob = True
    converter.mark_code = True
    converter.wrap_links = False
    converter.single_line_break = False

    if base_url:
        converter.baseurl = base_url

    md = converter.handle(html)

    # Clean up excessive blank lines
    import re
    md = re.sub(r'\n{3,}', '\n\n', md)
    return md.strip()


def extract_metadata(html):
    """Extract page metadata (title, description, etc.)."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    meta = {}

    # Title
    title_tag = soup.find("title")
    if title_tag:
        meta["title"] = title_tag.get_text(strip=True)

    # Meta description
    desc_tag = soup.find("meta", attrs={"name": "description"})
    if desc_tag and desc_tag.get("content"):
        meta["description"] = desc_tag["content"].strip()

    # OG tags
    for prop in ["og:title", "og:description", "og:type", "og:site_name"]:
        tag = soup.find("meta", attrs={"property": prop})
        if tag and tag.get("content"):
            meta[prop.replace("og:", "og_")] = tag["content"].strip()

    # Author
    author_tag = soup.find("meta", attrs={"name": "author"})
    if author_tag and author_tag.get("content"):
        meta["author"] = author_tag["content"].strip()

    # Published date
    for attr in ["article:published_time", "datePublished", "date"]:
        date_tag = soup.find("meta", attrs={"property": attr}) or soup.find("meta", attrs={"name": attr})
        if date_tag and date_tag.get("content"):
            meta["published"] = date_tag["content"].strip()
            break

    return meta


def main():
    setup_encoding()
    check_dependencies()

    parser = argparse.ArgumentParser(
        description="Fetch a web page and extract content as Markdown"
    )
    parser.add_argument("url", help="URL to fetch")
    parser.add_argument("--raw", action="store_true",
                        help="Output full page Markdown (no readability extraction)")
    parser.add_argument("--selector", type=str, default=None,
                        help="CSS selector to extract specific elements")
    parser.add_argument("--save", type=str, default=None,
                        help="Also save output to this file path")
    parser.add_argument("--max-length", type=int, default=None,
                        help="Truncate output to N characters")
    parser.add_argument("--timeout", type=int, default=30,
                        help="Request timeout in seconds (default: 30)")
    parser.add_argument("--max-attempts", type=int, default=3,
                        help="Max HTTP attempts before giving up (default: 3)")
    parser.add_argument("--no-metadata", action="store_true",
                        help="Skip metadata header in output")

    args = parser.parse_args()

    # Normalize URL
    url = args.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    print(f"Fetching: {url}", file=sys.stderr)

    # Fetch
    html, final_url, status = fetch_url(url, timeout=args.timeout, max_attempts=args.max_attempts)
    print(f"Status: {status}, Size: {len(html)} bytes", file=sys.stderr)

    if final_url != url:
        print(f"Redirected to: {final_url}", file=sys.stderr)

    # Extract metadata
    meta = extract_metadata(html) if not args.no_metadata else {}

    # Extract content
    if args.selector:
        # CSS selector mode
        selected_html = extract_with_selector(html, args.selector)
        if not selected_html:
            print(f"Warning: no elements matched selector '{args.selector}'", file=sys.stderr)
            print(f"[No elements matched CSS selector: {args.selector}]")
            sys.exit(0)
        title = meta.get("title", "")
        content_md = html_to_markdown(selected_html, base_url=final_url)
    elif args.raw:
        # Raw full-page mode
        title = meta.get("title", "")
        content_md = html_to_markdown(html, base_url=final_url)
    else:
        # Readability extraction mode (default)
        title, article_html = extract_with_readability(html, final_url)
        content_md = html_to_markdown(article_html, base_url=final_url)

    # Build output
    parts = []

    if not args.no_metadata and meta:
        parts.append(f"# {title or meta.get('title', 'Untitled')}")
        parts.append(f"\n**Source**: {final_url}")
        if meta.get("author"):
            parts.append(f"**Author**: {meta['author']}")
        if meta.get("published"):
            parts.append(f"**Published**: {meta['published']}")
        if meta.get("description"):
            parts.append(f"**Description**: {meta['description']}")
        parts.append("\n---\n")
    elif title and not args.no_metadata:
        parts.append(f"# {title}\n")

    parts.append(content_md)

    output = "\n".join(parts)

    # Truncate if requested
    if args.max_length and len(output) > args.max_length:
        output = output[:args.max_length] + f"\n\n[... truncated at {args.max_length} characters, total {len(output)}]"

    # Print to stdout
    print(output)

    content_length = len(content_md)
    print(f"\nExtracted: {content_length} characters", file=sys.stderr)

    # Save to file if requested
    if args.save:
        try:
            with open(args.save, "w", encoding="utf-8") as f:
                f.write(output)
            print(f"Saved to: {args.save}", file=sys.stderr)
        except Exception as e:
            print(f"Error saving file: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
