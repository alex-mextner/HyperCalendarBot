"""Entrypoint that runs every post-ship-deploy test via `python3 -B test/python/test_post_ship_deploy.py`.

The tests live in test_post_ship_deploy_<topic>.py (shared fixtures in post_ship_deploy_support.py).
Nothing is imported at module level, so `unittest discover` collects each topic file exactly once.
"""

import sys
import unittest

TOPICS = (
    "test_post_ship_deploy_core",
    "test_post_ship_deploy_wrapper",
    "test_post_ship_deploy_hosted",
    "test_post_ship_deploy_deploy",
)

if __name__ == "__main__":
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite(loader.loadTestsFromName(name) for name in TOPICS)
    sys.exit(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())
