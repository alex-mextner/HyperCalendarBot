"""Docker's own log rotation stays on for every service (owner requirement 7)."""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ComposeLoggingTests(unittest.TestCase):

    def test_every_service_rotates_json_file_logs_by_size_and_count(self):
        text = (ROOT / "docker-compose.yml").read_text()
        services = re.split(r"^  (?=[a-z][a-z0-9_-]*:\n)", text.split("\nservices:\n", 1)[1].split("\nvolumes:\n", 1)[0], flags=re.M)
        services = [block for block in services if block.strip()]
        self.assertGreaterEqual(len(services), 2)
        for block in services:
            name = block.split(":", 1)[0]
            self.assertIn('driver: "json-file"', block, name)
            size = re.search(r'max-size: "(\d+)m"', block)
            files = re.search(r'max-file: "(\d+)"', block)
            self.assertTrue(size and files, f"{name} has no max-size/max-file")
            # Enough history to survive a failed deploy's recreate window, bounded for the microSD.
            self.assertGreaterEqual(int(files.group(1)), 3, name)
            self.assertLessEqual(int(size.group(1)) * int(files.group(1)), 500, name)


if __name__ == "__main__":
    unittest.main()
