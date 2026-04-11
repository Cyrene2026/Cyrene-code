package main

import (
	"fmt"
	"os"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	model := app.NewModel()
	program := tea.NewProgram(
		model,
	)

	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "cyrene-v2: %v\n", err)
		os.Exit(1)
	}
}
