package app

import (
	"errors"
	"io"
	"strings"
	"sync"

	"github.com/charmbracelet/x/ansi"
)

type CursorAnchoredOutput struct {
	writer      io.Writer
	reader      io.Reader
	closer      io.Closer
	fd          func() uintptr
	anchor      func() TerminalCursorAnchor
	mu          sync.Mutex
	anchored    bool
	restoreRows int
}

func NewCursorAnchoredOutput(file interface {
	io.ReadWriteCloser
	Fd() uintptr
}, anchor func() TerminalCursorAnchor) *CursorAnchoredOutput {
	return &CursorAnchoredOutput{
		writer: file,
		reader: file,
		closer: file,
		fd:     file.Fd,
		anchor: anchor,
	}
}

func NewCursorAnchoredWriterForTest(writer io.Writer, anchor func() TerminalCursorAnchor) *CursorAnchoredOutput {
	return &CursorAnchoredOutput{
		writer: writer,
		anchor: anchor,
	}
}

func (w *CursorAnchoredOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.anchored {
		if _, err := io.WriteString(w.writer, restoreCursorAnchorSequence(w.restoreRows)); err != nil {
			return 0, err
		}
		w.anchored = false
		w.restoreRows = 0
	}

	n, err := w.writer.Write(p)
	if err != nil {
		return n, err
	}

	if w.anchor == nil {
		return n, nil
	}
	anchor := w.anchor()
	if !anchor.Active {
		return n, nil
	}
	if _, err := io.WriteString(w.writer, applyCursorAnchorSequence(anchor)); err != nil {
		return n, err
	}
	w.anchored = true
	w.restoreRows = anchor.RowsUp
	return n, nil
}

func (w *CursorAnchoredOutput) Read(p []byte) (int, error) {
	if w.reader == nil {
		return 0, errors.New("cursor anchored output is not readable")
	}
	return w.reader.Read(p)
}

func (w *CursorAnchoredOutput) Close() error {
	if w.closer == nil {
		return nil
	}
	return w.closer.Close()
}

func (w *CursorAnchoredOutput) Fd() uintptr {
	if w.fd == nil {
		return ^uintptr(0)
	}
	return w.fd()
}

func restoreCursorAnchorSequence(rowsDown int) string {
	if rowsDown <= 0 {
		return "\r"
	}
	return "\r" + ansi.CursorDown(rowsDown)
}

func applyCursorAnchorSequence(anchor TerminalCursorAnchor) string {
	var builder strings.Builder
	if anchor.RowsUp > 0 {
		builder.WriteString(ansi.CursorUp(anchor.RowsUp))
	}
	if anchor.ColumnsRight > 0 {
		builder.WriteString(ansi.CursorRight(anchor.ColumnsRight))
	}
	return builder.String()
}
