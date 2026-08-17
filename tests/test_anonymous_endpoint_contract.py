from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / "bangumi-proxy.nginx.conf").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


class AnonymousEndpointContractTest(unittest.TestCase):
    def test_search_and_subject_profiles_have_exact_methods(self) -> None:
        self.assertIn('~^/v0/search/subjects$ search;', CONFIG)
        self.assertIn('~^/v0/subjects/[0-9]+(?:/image)?$ subject_read;', CONFIG)
        self.assertIn('"search:POST" 1;', CONFIG)
        self.assertIn('"search:OPTIONS" 1;', CONFIG)
        self.assertNotIn('"search:GET" 1;', CONFIG)
        self.assertIn('"subject_read:GET" 1;', CONFIG)
        self.assertIn('"subject_read:HEAD" 1;', CONFIG)
        self.assertIn('"subject_read:OPTIONS" 1;', CONFIG)
        self.assertNotIn('"subject_read:POST" 1;', CONFIG)

    def test_public_api_never_forwards_credentials(self) -> None:
        self.assertGreaterEqual(CONFIG.count('proxy_set_header Authorization "";'), 2)
        self.assertGreaterEqual(CONFIG.count('proxy_set_header Cookie "";'), 2)
        self.assertGreaterEqual(CONFIG.count("proxy_hide_header Set-Cookie;"), 2)
        self.assertGreaterEqual(CONFIG.count("proxy_ignore_headers Set-Cookie;"), 2)
        self.assertNotIn("Access-Control-Allow-Credentials", "\n".join(
            line for line in CONFIG.splitlines() if line.lstrip().startswith("add_header")
        ))

    def test_cors_does_not_advertise_credentials_or_destructive_methods(self) -> None:
        add_headers = "\n".join(
            line.strip() for line in CONFIG.splitlines() if line.lstrip().startswith("add_header")
        )
        self.assertNotIn("Authorization,Content-Type", add_headers)
        self.assertNotIn("PUT", add_headers)
        self.assertNotIn("PATCH", add_headers)
        self.assertNotIn("DELETE", add_headers)
        self.assertIn('Access-Control-Allow-Headers "Accept, Content-Type"', add_headers)
        self.assertIn('Access-Control-Allow-Methods "GET, HEAD, OPTIONS"', add_headers)

    def test_readme_documents_the_anonymous_boundary(self) -> None:
        self.assertIn("## 匿名公开端点合同", README)
        self.assertIn("不能经过公开镜像", README)
        self.assertIn("`POST`, `OPTIONS`", README)
        self.assertIn("`GET`, `HEAD`, `OPTIONS`", README)


if __name__ == "__main__":
    unittest.main()
