"""Read bounded gallery files without following links or trusting path-only checks."""
from contextlib import ExitStack
import os
from pathlib import Path
import stat

MAX_IMAGE_BYTES = 4 * 1024 * 1024


class ImageUnavailable(ValueError):
    pass


def confined_path(root, filename):
    root, filename = Path(root), Path(filename)
    if not root.is_absolute() or not filename.is_absolute():
        raise ImageUnavailable('invalid_path')
    # Do not resolve links: every component is opened and checked below.
    if '..' in root.parts or '..' in filename.parts:
        raise ImageUnavailable('invalid_path')
    try:
        relative = filename.relative_to(root)
    except ValueError:
        raise ImageUnavailable('outside_gallery') from None
    if not relative.parts:
        raise ImageUnavailable('not_a_file')
    if os.name == 'nt':
        if len(root.drive) != 2 or root.drive[1] != ':':
            raise ImageUnavailable('local_volume_required')
        for part in filename.parts[1:]:
            if ':' in part or part.endswith((' ', '.')):
                raise ImageUnavailable('invalid_path')
    return filename


def _read_fd(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise ImageUnavailable('linked_or_nonregular_file')
    if not 0 < before.st_size <= MAX_IMAGE_BYTES:
        raise ImageUnavailable('invalid_image_size')
    chunks, remaining = [], MAX_IMAGE_BYTES + 1
    while remaining:
        block = os.read(fd, min(remaining, 65536))
        if not block:
            break
        chunks.append(block)
        remaining -= len(block)
    after = os.fstat(fd)
    fingerprint = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)
    content = b''.join(chunks)
    if fingerprint(before) != fingerprint(after) or len(content) != before.st_size:
        raise ImageUnavailable('image_changed')
    return content


def _read_posix(filename):
    with ExitStack() as stack:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open(filename.anchor, flags)
        stack.callback(os.close, directory)
        for component in filename.parts[1:-1]:
            directory = os.open(component, flags, dir_fd=directory)
            stack.callback(os.close, directory)
        fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        stack.callback(os.close, fd)
        return _read_fd(fd)


def _read_windows(filename):
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class FileInformation(ctypes.Structure):
        _fields_ = [('attributes', wintypes.DWORD), ('creation', wintypes.FILETIME),
                    ('access', wintypes.FILETIME), ('write', wintypes.FILETIME),
                    ('volume', wintypes.DWORD), ('size_high', wintypes.DWORD),
                    ('size_low', wintypes.DWORD), ('links', wintypes.DWORD),
                    ('index_high', wintypes.DWORD), ('index_low', wintypes.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    info = kernel.GetFileInformationByHandle
    info.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInformation)]
    info.restype = wintypes.BOOL

    def open_checked(path, directory):
        # Deny delete sharing for EVERY ancestor until the bytes have been read.
        # An attacker cannot replace a checked directory with a junction in between.
        handle = create(str(path), 0x80 if directory else 0x80000000,
                        3 if directory else 1, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ImageUnavailable('image_unavailable')
        data = FileInformation()
        if (not info(handle, ctypes.byref(data)) or data.attributes & 0x400
                or bool(data.attributes & 0x10) != directory
                or (not directory and data.links != 1)):
            close(handle)
            raise ImageUnavailable('linked_or_nonregular_file')
        return handle

    with ExitStack() as stack:
        current = Path(filename.anchor)
        stack.callback(close, open_checked(current, True))
        for component in filename.parts[1:-1]:
            current /= component
            stack.callback(close, open_checked(current, True))
        handle = open_checked(filename, False)
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            close(handle)
            raise
        stack.callback(os.close, fd)  # The fd owns the file HANDLE now.
        return _read_fd(fd)


def read_image_file(root, filename):
    filename = confined_path(root, filename)
    try:
        return (_read_windows if os.name == 'nt' else _read_posix)(filename)
    except OSError:
        raise ImageUnavailable('image_unavailable') from None
