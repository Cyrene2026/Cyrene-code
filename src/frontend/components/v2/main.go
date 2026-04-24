package main

import (
	"fmt"
	"os"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	model := app.NewModel()
	options := []tea.ProgramOption{tea.WithOutput(app.NewCursorAnchoredOutput(os.Stdout, model.TerminalCursorAnchor))}
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
