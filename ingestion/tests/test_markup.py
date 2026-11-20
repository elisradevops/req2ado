from app.canonical.markup import html_to_markdown, html_to_plain, looks_like_html


def test_text_that_is_not_html_is_returned_exactly() -> None:
    for text in [
        "plain text & more",
        "AT&T; ok",
        "a < b and c > d",
        "**already** markdown\n\n- item",
        "",
    ]:
        assert html_to_markdown(text) == text


def test_divs_bold_and_lists_become_markdown() -> None:
    html = "<div><b>Requirement (R-1):</b> The unit shall start.</div><br><div><b>Notes:</b></div><ul><li>one</li><li>two</li></ul>"
    assert html_to_markdown(html) == (
        "**Requirement (R-1):** The unit shall start.\n\n**Notes:**\n\n- one\n- two"
    )


def test_nested_lists_keep_their_depth() -> None:
    assert html_to_markdown("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>") == "- a\n  - b\n- c"


def test_entities_are_decoded_and_whitespace_around_bold_moves_outside_the_markers() -> None:
    assert html_to_markdown("a <b> bold </b> &amp; <i>it</i>") == "a **bold** & *it*"


def test_a_table_block_in_text_becomes_plain_lines_not_a_live_table() -> None:
    # Only the tables ingestion renders itself (tree_builder._table_to_html) reach the write-back's trusted passthrough.
    out = html_to_markdown("<div>x</div><table><tr><td>1</td></tr></table><div>y</div>")
    assert out == "x\n\n1\n\ny"


def test_links_and_script_content() -> None:
    assert (
        html_to_markdown("<p>see <a href='https://x.io'>link</a></p>") == "see [link](https://x.io)"
    )
    assert html_to_markdown("<div>keep</div><script>alert(1)</script>") == "keep"


def test_plain_text_for_a_title() -> None:
    assert html_to_plain("<b>Title</b> &amp;  more") == "Title & more"
    assert looks_like_html("<div>x</div>") and not looks_like_html("x < y")


PLAIN_REQUIREMENTS = [
    "If x<b and y>c then fail",
    "The UI shall render the <br> tag and <p> elements.",
    "Compare a<i and i>b",
    "The page shall strip any <script> tag and render a <table> as text.",
    "The voltage shall be < 5V and > 3V.",
    "When temp<0 or temp>100 the unit shall raise an alarm.",
    "Use the <b> key to toggle and the <i> key for info.",
    "Latency <= 10 ms; throughput >= 100 Mb/s.",
    "The parser shall accept <a> and <div> as element names.",
    "The system shall log a<b>c as an error.",
    "Insert a line break with <br> between items.",
    "R&D shall approve; AT&T; ok",
    "Fields: <name>, <value>, <unit>.",
    "Arrow -> and <- are shown.",
    "Press <Enter> to continue.",
]


def test_plain_requirement_sentences_are_returned_exactly() -> None:
    for text in PLAIN_REQUIREMENTS:
        assert not looks_like_html(text), text
        assert html_to_markdown(text) == text, text
        assert html_to_plain(text) == text, text


def test_real_tracker_html_still_converts() -> None:
    assert html_to_markdown("<ul><li>one</li><li>two <b>bold</b></li></ul>") == "- one\n- two **bold**"
    assert html_to_markdown("line one<br>line two<br/>line three") == "line one\nline two\nline three"
    assert html_to_markdown('<div style="color: red">a</div><div>b</div>') == "a\n\nb"


def test_entity_only_text_is_decoded_only_when_nothing_is_left_raw() -> None:
    assert html_to_markdown("R&amp;D shall approve") == "R&D shall approve"
    # A bare "&" next to an entity: the text was not encoded, so it is left as written.
    assert html_to_markdown("R&amp;D & AT&T") == "R&amp;D & AT&T"


def test_an_encoded_table_does_not_become_a_live_table() -> None:
    text = "See &lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;img src=x onerror=alert(1)&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt; here"
    out = html_to_markdown(text)
    assert "<table" not in out and "<img" not in out
    assert "&lt;table>" in out  # still shown as the literal characters once rendered


def test_a_raw_table_inside_text_becomes_plain_lines() -> None:
    out = html_to_markdown('<div>x</div><table onclick="alert(1)"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
    assert out == "x\n\na | b\nc | d"
