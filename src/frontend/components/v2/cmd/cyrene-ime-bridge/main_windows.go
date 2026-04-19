//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmActivate          = 0x0006
	wmDestroy           = 0x0002
	wmShowWindow        = 0x0018
	wmSize              = 0x0005
	wmSetFocus          = 0x0007
	wmChar              = 0x0102
	wmKeyDown           = 0x0100
	wmIMEEndComposition = 0x010E
	wmIMEComposition    = 0x010F

	gcsCompStr   = 0x0008
	gcsCursorPos = 0x0080
	gcsResultStr = 0x0800

	csHRedraw = 0x0002
	csVRedraw = 0x0001

	cwUseDefault  = 0x80000000
	swShow        = 5
	gwlpWndProc   = ^uintptr(3)
	hwndTopMost   = ^uintptr(0)
	hwndNoTopMost = ^uintptr(1)

	wsOverlapped   = 0x00000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsVisible      = 0x10000000
	wsTabStop      = 0x00010000
	wsChild        = 0x40000000
	wsBorder       = 0x00800000
	wsExToolWindow = 0x00000080

	esAutoHScroll = 0x0080

	swpNoMove     = 0x0002
	swpNoSize     = 0x0001
	swpShowWindow = 0x0040

	vkBack    = 0x08
	vkTab     = 0x09
	vkReturn  = 0x0D
	vkEscape  = 0x1B
	vkSpace   = 0x20
	vkEnd     = 0x23
	vkHome    = 0x24
	vkLeft    = 0x25
	vkUp      = 0x26
	vkRight   = 0x27
	vkDown    = 0x28
	vkDelete  = 0x2E
	vkControl = 0x11
)

type nativeEvent struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Cursor int    `json:"cursor,omitempty"`
	Key    string `json:"key,omitempty"`
}

type point struct {
	X int32
	Y int32
}

type msg struct {
	HWnd    windows.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	imm32                        = windows.NewLazySystemDLL("imm32.dll")
	procAttachThreadInput        = user32.NewProc("AttachThreadInput")
	procBringWindowToTop         = user32.NewProc("BringWindowToTop")
	procCallWindowProcW          = user32.NewProc("CallWindowProcW")
	procCreateWindowExW          = user32.NewProc("CreateWindowExW")
	procDefWindowProcW           = user32.NewProc("DefWindowProcW")
	procDispatchMessageW         = user32.NewProc("DispatchMessageW")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetKeyState              = user32.NewProc("GetKeyState")
	procGetMessageW              = user32.NewProc("GetMessageW")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procLoadCursorW              = user32.NewProc("LoadCursorW")
	procMoveWindow               = user32.NewProc("MoveWindow")
	procPostQuitMessage          = user32.NewProc("PostQuitMessage")
	procRegisterClassExW         = user32.NewProc("RegisterClassExW")
	procSetActiveWindow          = user32.NewProc("SetActiveWindow")
	procSetFocus                 = user32.NewProc("SetFocus")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procSetWindowTextW           = user32.NewProc("SetWindowTextW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procTranslateMessage         = user32.NewProc("TranslateMessage")
	procUpdateWindow             = user32.NewProc("UpdateWindow")
	procGetCurrentThreadID       = kernel32.NewProc("GetCurrentThreadId")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
	procImmGetContext            = imm32.NewProc("ImmGetContext")
	procImmReleaseContext        = imm32.NewProc("ImmReleaseContext")
	procImmGetCompStrW           = imm32.NewProc("ImmGetCompositionStringW")

	writer = bufio.NewWriter(os.Stdout)

	parentProcPtr       = syscall.NewCallback(windowProc)
	inputProcPtr        = syscall.NewCallback(inputWindowProc)
	inputHandle         windows.Handle
	originalInputProc   uintptr
	suppressedCharCount int
)

func main() {
	runtime.LockOSThread()
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "cyrene-ime-bridge: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	instance, _, err := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return err
	}

	className, _ := windows.UTF16PtrFromString("CyreneImeBridgeWindow")
	title, _ := windows.UTF16PtrFromString("Cyrene Input")
	cursor, _, _ := procLoadCursorW.Call(0, uintptr(32512))
	class := wndClassEx{
		Size:       uint32(unsafe.Sizeof(wndClassEx{})),
		Style:      csHRedraw | csVRedraw,
		WndProc:    parentProcPtr,
		Instance:   windows.Handle(instance),
		Cursor:     windows.Handle(cursor),
		ClassName:  className,
		Background: 0,
	}
	if atom, _, callErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return callErr
	}

	hwnd, _, callErr := procCreateWindowExW.Call(
		uintptr(wsExToolWindow),
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		uintptr(wsOverlapped|wsCaption|wsSysMenu|wsVisible),
		uintptr(cwUseDefault), uintptr(cwUseDefault),
		uintptr(760), uintptr(104),
		0, 0,
		instance,
		0,
	)
	if hwnd == 0 {
		return callErr
	}

	if err := createInputWindow(windows.Handle(hwnd), windows.Handle(instance)); err != nil {
		return err
	}

	procShowWindow.Call(hwnd, swShow)
	procUpdateWindow.Call(hwnd)
	ensureInputFocus(windows.Handle(hwnd))

	var message msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		switch int32(result) {
		case -1:
			return fmt.Errorf("GetMessageW failed")
		case 0:
			return writer.Flush()
		default:
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
		}
	}
}

func createInputWindow(parent windows.Handle, instance windows.Handle) error {
	className, _ := windows.UTF16PtrFromString("EDIT")
	initialText, _ := windows.UTF16PtrFromString("")
	hwnd, _, callErr := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(initialText)),
		uintptr(wsChild|wsVisible|wsTabStop|wsBorder|esAutoHScroll),
		uintptr(16), uintptr(16),
		uintptr(720), uintptr(30),
		uintptr(parent),
		0,
		uintptr(instance),
		0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW edit control failed: %v", callErr)
	}
	inputHandle = windows.Handle(hwnd)
	previous, _, _ := procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, inputProcPtr)
	originalInputProc = previous
	resizeInputWindow(parent, 760, 104)
	return nil
}

func windowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmActivate, wmShowWindow:
		ensureInputFocus(windows.Handle(hwnd))
		return 0
	case wmSetFocus:
		ensureInputFocus(windows.Handle(hwnd))
		return 0
	case wmSize:
		resizeInputWindow(windows.Handle(hwnd), int32(loword(lParam)), int32(hiword(lParam)))
		return 0
	case wmDestroy:
		emit(nativeEvent{Type: "composition_clear"})
		procPostQuitMessage.Call(0)
		return 0
	default:
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return ret
	}
}

func inputWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case wmKeyDown:
		if key, ok := translateVirtualKey(uint32(wParam)); ok {
			emit(nativeEvent{Type: "key", Key: key})
			return 0
		}
	case wmChar:
		if suppressedCharCount > 0 {
			suppressedCharCount--
			clearInputWindow()
			return 0
		}
		r := rune(wParam)
		if r >= 0x20 && r != 0x7f {
			emit(nativeEvent{Type: "text_input", Text: string(r)})
			clearInputWindow()
			return 0
		}
		return 0
	case wmIMEComposition:
		handleIMEComposition(windows.Handle(hwnd), lParam)
	case wmIMEEndComposition:
		emit(nativeEvent{Type: "composition_clear"})
		clearInputWindow()
	}
	return callOriginalInputProc(hwnd, message, wParam, lParam)
}

func handleIMEComposition(hwnd windows.Handle, lParam uintptr) {
	himc, _, _ := procImmGetContext.Call(uintptr(hwnd))
	if himc == 0 {
		return
	}
	defer procImmReleaseContext.Call(uintptr(hwnd), himc)

	if lParam&gcsCompStr != 0 {
		text := getCompositionString(himc, gcsCompStr)
		cursor := int(getCompositionCursor(himc))
		emit(nativeEvent{Type: "composition_update", Text: text, Cursor: cursor})
	}
	if lParam&gcsResultStr != 0 {
		text := getCompositionString(himc, gcsResultStr)
		if text != "" {
			suppressedCharCount += len(utf16.Encode([]rune(text)))
			emit(nativeEvent{Type: "composition_commit", Text: text})
		}
	}
}

func getCompositionCursor(himc uintptr) int32 {
	value, _, _ := procImmGetCompStrW.Call(himc, uintptr(gcsCursorPos), 0, 0)
	return int32(value)
}

func getCompositionString(himc uintptr, kind uint32) string {
	size, _, _ := procImmGetCompStrW.Call(himc, uintptr(kind), 0, 0)
	if int32(size) <= 0 {
		return ""
	}
	buffer := make([]uint16, (size/2)+1)
	procImmGetCompStrW.Call(himc, uintptr(kind), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size))
	return strings.TrimRight(windows.UTF16ToString(buffer), "\x00")
}

func translateVirtualKey(code uint32) (string, bool) {
	ctrlDown := isKeyPressed(vkControl)
	switch code {
	case vkBack:
		return "backspace", true
	case vkDelete:
		return "delete", true
	case vkLeft:
		return "left", true
	case vkRight:
		return "right", true
	case vkUp:
		return "up", true
	case vkDown:
		return "down", true
	case vkHome:
		return "home", true
	case vkEnd:
		return "end", true
	case vkEscape:
		return "escape", true
	case vkTab:
		return "tab", true
	case vkReturn:
		return "enter", true
	case vkSpace:
		return "space", true
	}
	if ctrlDown {
		switch code {
		case 'J':
			return "ctrl+j", true
		case 'U':
			return "ctrl+u", true
		case 'K':
			return "ctrl+k", true
		case 'W':
			return "ctrl+w", true
		case 'D':
			return "ctrl+d", true
		}
	}
	return "", false
}

func isKeyPressed(code int32) bool {
	value, _, _ := procGetKeyState.Call(uintptr(code))
	return value&0x8000 != 0
}

func resizeInputWindow(parent windows.Handle, width int32, height int32) {
	if inputHandle == 0 {
		return
	}
	marginX := int32(16)
	marginY := int32(14)
	controlWidth := width - marginX*2
	if controlWidth < 64 {
		controlWidth = 64
	}
	controlHeight := height - marginY*2
	if controlHeight < 28 {
		controlHeight = 28
	}
	procMoveWindow.Call(
		uintptr(inputHandle),
		uintptr(marginX),
		uintptr(marginY),
		uintptr(controlWidth),
		uintptr(controlHeight),
		1,
	)
	_ = parent
}

func ensureInputFocus(parent windows.Handle) {
	if parent == 0 || inputHandle == 0 {
		return
	}
	currentThread, _, _ := procGetCurrentThreadID.Call()
	foregroundWindow, _, _ := procGetForegroundWindow.Call()
	attached := false
	var foregroundThread uintptr
	if foregroundWindow != 0 {
		foregroundThread, _, _ = procGetWindowThreadProcessId.Call(foregroundWindow, 0)
		if foregroundThread != 0 && foregroundThread != currentThread {
			procAttachThreadInput.Call(currentThread, foregroundThread, 1)
			attached = true
		}
	}
	procShowWindow.Call(uintptr(parent), swShow)
	procSetWindowPos.Call(uintptr(parent), hwndTopMost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
	procBringWindowToTop.Call(uintptr(parent))
	procSetActiveWindow.Call(uintptr(parent))
	procSetForegroundWindow.Call(uintptr(parent))
	procSetFocus.Call(uintptr(inputHandle))
	procSetWindowPos.Call(uintptr(parent), hwndNoTopMost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpShowWindow)
	if attached {
		procAttachThreadInput.Call(currentThread, foregroundThread, 0)
	}
}

func clearInputWindow() {
	if inputHandle == 0 {
		return
	}
	empty, _ := windows.UTF16PtrFromString("")
	procSetWindowTextW.Call(uintptr(inputHandle), uintptr(unsafe.Pointer(empty)))
}

func callOriginalInputProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	if originalInputProc == 0 {
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return ret
	}
	ret, _, _ := procCallWindowProcW.Call(originalInputProc, hwnd, uintptr(message), wParam, lParam)
	return ret
}

func loword(value uintptr) uint16 {
	return uint16(value & 0xffff)
}

func hiword(value uintptr) uint16 {
	return uint16((value >> 16) & 0xffff)
}

func emit(event nativeEvent) {
	encoder := json.NewEncoder(writer)
	_ = encoder.Encode(event)
	_ = writer.Flush()
}
