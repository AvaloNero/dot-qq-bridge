"""Send CTRL_BREAK to an owned fresh hidden child console; never enumerate logs."""
import ctypes as c
from ctypes import wintypes as w
import os
import json
import threading
import sys

def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit(): return 1
    pid = int(sys.argv[1])
    if pid <= 0 or pid == os.getpid(): return 1
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.AttachConsole.argtypes = [w.DWORD]
    kernel.GenerateConsoleCtrlEvent.argtypes = [w.DWORD, w.DWORD]
    handler_type = c.WINFUNCTYPE(w.BOOL, w.DWORD)
    seen = threading.Event()
    def handled(_event):
        seen.set(); return True
    handler = handler_type(handled)
    kernel.SetConsoleCtrlHandler.argtypes = [handler_type, w.BOOL]
    # CREATE_NO_WINDOW provides no inherited interactive console.
    kernel.FreeConsole()
    if not kernel.AttachConsole(pid):
        print(json.dumps({'stage':'attach_failed','winerror':c.get_last_error()})); return 1
    try:
        if not kernel.SetConsoleCtrlHandler(handler, True):
            print(json.dumps({'stage':'handler_failed','winerror':c.get_last_error()})); return 1
        if not kernel.GenerateConsoleCtrlEvent(1, 0):
            print(json.dumps({'stage':'signal_failed','winerror':c.get_last_error()})); return 1
        # FreeConsole resets handlers. Let our asynchronous CTRL_BREAK handler
        # finish first, otherwise a pending event could terminate this helper.
        seen.wait(2)
        print('{"stage":"break_sent"}'); return 0
    finally: kernel.FreeConsole()

if __name__ == '__main__': raise SystemExit(main())
