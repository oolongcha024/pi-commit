"""Drive the real CLI/Git signing path through a controlling terminal.

Only return boolean observations. Never print the captured terminal transcript.
"""
import json
import os
import pty
import re
import select
import signal
import sys
import termios
import time

command = json.loads(os.environ["SIGNING_TEST_COMMAND"])
scenario = os.environ["SIGNING_TEST_SCENARIO"]
password = os.environ["SIGNING_TEST_PASSWORD"]
wrong_password = "intentionally-wrong-test-input"
pid, master = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, dict(os.environ, TERM="xterm-256color"))

output = b""
phase = "draft"
deadline = time.monotonic() + 8
exit_status = None
prompt_count = 0

def visible_text():
    # Action labels can contain ANSI styling between the key and its label.
    return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)

try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        visible = visible_text()
        if phase == "draft" and "输入修改意见，或选择操作".encode() in visible:
            os.write(master, b"y\n")
            phase = "password"
        if phase == "password" and output.count(b"Enter passphrase") > prompt_count:
            prompt_count = output.count(b"Enter passphrase")
            if scenario == "cancel":
                os.write(master, b"\x03")
                phase = "done"
            else:
                value = wrong_password if scenario == "retry" and prompt_count == 1 else password
                os.write(master, (value + "\n").encode())
                phase = "failed" if scenario == "retry" and prompt_count == 1 else "done"
        if phase == "failed" and "y 重试提交".encode() in visible:
            os.write(master, b"e\n")
            phase = "edited"
        if phase == "edited" and b"fix: revise signed draft" in visible:
            os.write(master, b"y\n")
            phase = "password"
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            exit_status = os.waitstatus_to_exitcode(status)
            # Drain final output without waiting for another process on the tty.
            while select.select([master], [], [], 0)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
            break
finally:
    if exit_status is None:
        # PTY EOF may arrive just before waitpid observes the child's exit.
        for _ in range(20):
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited:
                exit_status = os.waitstatus_to_exitcode(status)
                break
            time.sleep(0.01)
        if exit_status is None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                # Darwin may report EPERM for an already-empty process group.
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            _, status = os.waitpid(pid, 0)
            exit_status = os.waitstatus_to_exitcode(status)
    visible = visible_text()
    result = {
        "exit_code": exit_status,
        "password_prompt_seen": prompt_count > 0,
        "password_echoed": password.encode() in output or wrong_password.encode() in output,
        "committed": "提交完成。".encode() in output,
        "raw_restored": b"RAW_RESTORED=true" in output,
        "cancelled": b"SIGNING_CANCELLED" in output,
        "retried_after_edit": b"fix: revise signed draft" in visible,
    }
    print(json.dumps(result), flush=True)
    # Flush the slave's pending output before closing a macOS PTY master.
    termios.tcflush(master, termios.TCIOFLUSH)
    os.set_blocking(master, False)
    os.close(master)
