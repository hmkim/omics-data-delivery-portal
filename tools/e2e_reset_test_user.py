#!/usr/bin/env python3
"""Reset the portal e2e test user's password and write the 0600 credentials file Playwright reads.

The password is generated here, passed to the AWS CLI as an argument (never printed), and written to
~/.cache/genome-portal-e2e/user-login.txt (line 1 e-mail, line 2 password), outside the temp dir so it
survives temp-dir cleanup. Set E2E_USER_POOL_ID and E2E_USER for your deployment.
"""
import os
import secrets
import string
import subprocess
import sys

POOL = os.environ.get("E2E_USER_POOL_ID", "ap-northeast-2_EXAMPLE")
USER = os.environ.get("E2E_USER", "demo-user@example.org")
OUT_DIR = os.path.expanduser("~/.cache/genome-portal-e2e")
OUT = os.path.join(OUT_DIR, "user-login.txt")

alphabet = string.ascii_letters + string.digits
pw = "".join(secrets.choice(alphabet) for _ in range(20)) + "!Aa1"  # satisfies the pool's policy classes

res = subprocess.run(
    [
        "aws", "cognito-idp", "admin-set-user-password",
        "--user-pool-id", POOL, "--username", USER, "--password", pw, "--permanent",
        "--region", "ap-northeast-2",
    ],
    capture_output=True, text=True,
)
if res.returncode != 0:
    sys.stderr.write(res.stderr.replace(pw, "<redacted>"))
    sys.exit(res.returncode)

os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
os.chmod(OUT_DIR, 0o700)
fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(f"{USER}\n{pw}\n")
os.chmod(OUT, 0o600)
print(f"password reset for {USER}; credentials written to {OUT} (0600)")
