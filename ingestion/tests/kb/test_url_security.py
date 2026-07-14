import pytest

from app.kb.url_security import validate_fetch_url, validate_share_url, verify_supported_content


class TestValidateFetchUrl:
    def test_accepts_an_https_cdn_style_url_not_on_the_share_allowlist(self):
        validate_fetch_url("https://public-blob.example.net/download?tempauth=xyz")

    def test_rejects_non_https_scheme(self):
        with pytest.raises(ValueError):
            validate_fetch_url("http://public-blob.example.net/download")

    def test_rejects_private_ip_literal(self):
        with pytest.raises(ValueError):
            validate_fetch_url("https://169.254.169.254/latest/meta-data")

    def test_rejects_loopback_ip_literal(self):
        with pytest.raises(ValueError):
            validate_fetch_url("https://127.0.0.1/secret")


class TestValidateShareUrl:
    def test_accepts_sharepoint_url(self):
        validate_share_url("https://contoso.sharepoint.com/:w:/r/sites/x/doc.docx")

    def test_accepts_onedrive_com_url(self):
        validate_share_url("https://contoso.onedrive.com/doc.docx")

    def test_accepts_sharepoint_us_url(self):
        validate_share_url("https://contoso.sharepoint.us/doc.docx")

    def test_accepts_onedrive_live_com_url(self):
        validate_share_url("https://onedrive.live.com/doc.docx")

    def test_accepts_1drv_ms_short_link(self):
        validate_share_url("https://1drv.ms/w/s!AbCdEf")

    def test_rejects_non_http_scheme(self):
        with pytest.raises(ValueError):
            validate_share_url("ftp://contoso.sharepoint.com/x")

    def test_rejects_disallowed_host(self):
        with pytest.raises(ValueError):
            validate_share_url("https://evil.com/x")

    def test_rejects_private_ip_literal(self):
        with pytest.raises(ValueError):
            validate_share_url("http://169.254.169.254/latest")

    def test_rejects_lookalike_domain_suffix(self):
        # Regression: a raw str.endswith would let an attacker-registered
        # lookalike through ("fakeonedrive.com".endswith("onedrive.com")).
        # The suffix must be anchored at a domain-label boundary.
        with pytest.raises(ValueError):
            validate_share_url("https://fakeonedrive.com/x")
        with pytest.raises(ValueError):
            validate_share_url("https://evil-sharepoint.com/x")
        with pytest.raises(ValueError):
            validate_share_url("https://sharepoint.com.attacker.net/x")


class TestVerifySupportedContent:
    def test_pdf_valid(self):
        verify_supported_content("doc.pdf", b"%PDF-1.7 ...")

    def test_pdf_invalid(self):
        with pytest.raises(ValueError):
            verify_supported_content("doc.pdf", b"not a pdf")

    def test_docx_valid(self):
        verify_supported_content("doc.docx", b"PK\x03\x04....")

    def test_docx_invalid(self):
        with pytest.raises(ValueError):
            verify_supported_content("doc.docx", b"plain")

    def test_txt_valid(self):
        verify_supported_content("notes.txt", "hello".encode())

    def test_unsupported_extension(self):
        with pytest.raises(ValueError):
            verify_supported_content("x.exe", b"MZ")
