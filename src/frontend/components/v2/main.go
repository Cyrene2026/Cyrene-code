package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

type cursorAnchoredOutput struct {
	file        *os.File
	anchor      func() app.TerminalCursorAnchor
	mu          sync.Mutex
	anchored    bool
	restoreRows int
}

func (w *cursorAnchoredOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.anchored {
		if _, err := io.WriteString(w.file, restoreCursorAnchorSequence(w.restoreRows)); err != nil {
			return 0, err
		}
		w.anchored = false
		w.restoreRows = 0
	}

	n, err := w.file.Write(p)
	if err != nil {
		return n, err
	}

	anchor := w.anchor()
	if !anchor.Active {
		return n, nil
	}
	if _, err := io.WriteString(w.file, applyCursorAnchorSequence(anchor)); err != nil {
		return n, err
	}
	w.anchored = true
	w.restoreRows = anchor.RowsUp
	return n, nil
}

func (w *cursorAnchoredOutput) Read(p []byte) (int, error) {
	return w.file.Read(p)
}

func (w *cursorAnchoredOutput) Close() error {
	return w.file.Close()
}

func (w *cursorAnchoredOutput) Fd() uintptr {
	return w.file.Fd()
}

func restoreCursorAnchorSequence(rowsDown int) string {
	if rowsDown <= 0 {
		return "\r"
	}
	return "\r" + ansi.CursorDown(rowsDown)
}

func applyCursorAnchorSequence(anchor app.TerminalCursorAnchor) string {
	var builder strings.Builder
	if anchor.RowsUp > 0 {
		builder.WriteString(ansi.CursorUp(anchor.RowsUp))
	}
	if anchor.ColumnsRight > 0 {
		builder.WriteString(ansi.CursorRight(anchor.ColumnsRight))
	}
	return builder.String()
}

func main() {
	model := app.NewModel()
	anchoredOutput := &cursorAnchoredOutput{
		file:   os.Stdout,
		anchor: model.TerminalCursorAnchor,
	}
	options := []tea.ProgramOption{tea.WithOutput(anchoredOutput)}
	if model.MouseCapture {
		options = append(options, tea.WithMouseCellMotion())
	}
	program := tea.NewProgram(
		model,
		options...,
	)

	finalModel, err := program.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "cyrene-v2: %v\n", err)
		os.Exit(1)
	}
	if resolved, ok := finalModel.(*app.Model); ok && resolved.ShouldPrintExitSummary() {
		fmt.Fprint(os.Stdout, "\033[2J\033[H")
		fmt.Fprintln(os.Stdout, resolved.ExitSummaryText())
	}
}
