"""Owned Windows supervisor primitives; no provider or Tunnel configuration reads."""
import ctypes as c
from ctypes import wintypes as w
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('dot_native_windows', Path(__file__).resolve().parents[2] / 'packages/dot-bridge-platform/windows.py')
win = importlib.util.module_from_spec(spec)
spec.loader.exec_module(win)
api, kernel, HANDLE, DWORD = win.api, win.kernel, win.HANDLE, win.DWORD

class Overlapped(c.Structure):
    _fields_ = [('Internal', c.c_size_t), ('InternalHigh', c.c_size_t), ('Offset', DWORD), ('OffsetHigh', DWORD), ('event', HANDLE)]
LockFileEx = api(kernel, 'LockFileEx', [HANDLE, DWORD, DWORD, DWORD, DWORD, c.POINTER(Overlapped)])

class Lease:
    def __init__(self, path):
        self.parent, self.handle = win.write_new(str(path), str(os.getpid()).encode(), retain=True)
        try:
            self.identity = win.private(self.handle)['identity']
            self.digest = hashlib.sha256(win.read_handle(self.handle, 1024)).digest()
            self.overlap = Overlapped()
            win.check(LockFileEx(self.handle, 3, 0, 1, 0, c.byref(self.overlap)))
        except BaseException:
            win.dispose(self.handle); self.close(); raise
    def release(self):
        win.private(self.parent.handle, directory=True)
        if win.private(self.handle)['identity'] != self.identity or hashlib.sha256(win.read_handle(self.handle, 1024)).digest() != self.digest:
            raise win.Unsafe('identity')
        win.dispose(self.handle)
    def close(self):
        if self.handle is not None: win.CloseHandle(self.handle); self.handle = None
        self.parent.close()

class ProcessEntry(c.Structure):
    _fields_ = [('size', DWORD), ('usage', DWORD), ('pid', DWORD), ('heap', c.c_size_t), ('module', DWORD),
                ('threads', DWORD), ('parent', DWORD), ('priority', c.c_long), ('flags', DWORD), ('name', w.WCHAR * 260)]
class ThreadEntry(c.Structure):
    _fields_ = [('size', DWORD), ('usage', DWORD), ('tid', DWORD), ('owner', DWORD), ('base', c.c_long), ('delta', c.c_long), ('flags', DWORD)]
Snapshot = api(kernel, 'CreateToolhelp32Snapshot', [DWORD, DWORD], HANDLE)
ProcessFirst = api(kernel, 'Process32FirstW', [HANDLE, c.POINTER(ProcessEntry)])
ProcessNext = api(kernel, 'Process32NextW', [HANDLE, c.POINTER(ProcessEntry)])
ThreadFirst = api(kernel, 'Thread32First', [HANDLE, c.POINTER(ThreadEntry)])
ThreadNext = api(kernel, 'Thread32Next', [HANDLE, c.POINTER(ThreadEntry)])
OpenThread = api(kernel, 'OpenThread', [DWORD, w.BOOL, DWORD], HANDLE)
ResumeThread = api(kernel, 'ResumeThread', [HANDLE], DWORD)
GetProcessIdOfThread = api(kernel, 'GetProcessIdOfThread', [HANDLE], DWORD)

def existing_client(client):
    snapshot = Snapshot(2, 0)
    if snapshot in (None, win.INVALID): raise RuntimeError('process_guard_unavailable')
    try:
        entry = ProcessEntry(); entry.size = c.sizeof(entry)
        if not ProcessFirst(snapshot, c.byref(entry)): raise RuntimeError('process_guard_unavailable')
        names = {Path(client).name.casefold(), 'tunnel-client.exe', 'tunnel-client'}
        while True:
            if entry.name.casefold() in names: return True
            if not ProcessNext(snapshot, c.byref(entry)):
                if c.get_last_error() != 18: raise RuntimeError('process_guard_unavailable')
                return False
    finally: win.CloseHandle(snapshot)

class BasicLimits(c.Structure):
    _fields_ = [('per_process', c.c_longlong), ('per_job', c.c_longlong), ('flags', DWORD),
                ('minimum', c.c_size_t), ('maximum', c.c_size_t), ('active_limit', DWORD),
                ('affinity', c.c_size_t), ('priority', DWORD), ('scheduling', DWORD)]
class IoCounters(c.Structure):
    _fields_ = [(key, c.c_ulonglong) for key in ('read_ops','write_ops','other_ops','read_bytes','write_bytes','other_bytes')]
class ExtendedLimits(c.Structure):
    _fields_ = [('basic', BasicLimits), ('io', IoCounters), ('process_memory', c.c_size_t), ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]
class Accounting(c.Structure):
    _fields_ = [('user', c.c_longlong), ('kernel', c.c_longlong), ('period_user', c.c_longlong), ('period_kernel', c.c_longlong),
                ('page_faults', DWORD), ('total', DWORD), ('active', DWORD), ('terminated', DWORD)]
CreateJob = api(kernel, 'CreateJobObjectW', [HANDLE, w.LPCWSTR], HANDLE)
SetJob = api(kernel, 'SetInformationJobObject', [HANDLE, c.c_int, HANDLE, DWORD])
AssignJob = api(kernel, 'AssignProcessToJobObject', [HANDLE, HANDLE])
QueryJob = api(kernel, 'QueryInformationJobObject', [HANDLE, c.c_int, HANDLE, DWORD, c.POINTER(DWORD)])
TerminateJob = api(kernel, 'TerminateJobObject', [HANDLE, w.UINT])

class OwnedJob:
    def __init__(self):
        self.handle = CreateJob(None, None); win.check(self.handle)
        limits = ExtendedLimits(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE, no breakaway.
        try: win.check(SetJob(self.handle, 9, c.byref(limits), c.sizeof(limits)))
        except BaseException: self.close(); raise
    def adopt_suspended(self, process):
        win.check(AssignJob(self.handle, int(process._handle)))
        snapshot = Snapshot(4, 0)
        if snapshot in (None, win.INVALID): raise win.Unsafe()
        found = []
        try:
            entry = ThreadEntry(); entry.size = c.sizeof(entry)
            more = ThreadFirst(snapshot, c.byref(entry))
            while more:
                if entry.owner == process.pid: found.append(entry.tid)
                more = ThreadNext(snapshot, c.byref(entry))
            if c.get_last_error() != 18 or len(found) != 1: raise win.Unsafe()
            thread = OpenThread(2 | 0x800, False, found[0]); win.check(thread)
            try:
                if GetProcessIdOfThread(thread) != process.pid or ResumeThread(thread) != 1: raise win.Unsafe('identity')
            finally: win.CloseHandle(thread)
        finally: win.CloseHandle(snapshot)
    def active(self):
        result = Accounting()
        win.check(QueryJob(self.handle, 1, c.byref(result), c.sizeof(result), None))
        return result.active
    def wait_empty(self, seconds=2):
        deadline = time.monotonic() + seconds
        while self.active():
            if time.monotonic() >= deadline: return False
            time.sleep(.01)
        return True
    def terminate(self): win.check(TerminateJob(self.handle, 1))
    def close(self):
        if self.handle: win.CloseHandle(self.handle); self.handle = None

def request_break(process):
    # This helper attaches only to the hidden, fresh console of an owned child.
    # Popen keeps its process handle alive, preventing PID reuse during the call.
    helper = Path(__file__).with_name('windows-console-stop.py')
    result = subprocess.run([sys.executable, '-B', '-I', '-S', str(helper), str(process.pid)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=5)
    return result.returncode == 0
