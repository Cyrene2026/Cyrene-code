package main

import (
	"fmt"
	"os"
	"runtime"

	"cyrenecode/v2/internal/app"
	"cyrenecode/v2/internal/nativeinput"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	model := app.NewModel()
	useNativeInput := runtime.GOOS == "windows" && nativeinput.Available()
	program := tea.NewProgram(model, programOptions(model.MouseCapture, useNativeInput)...)
	if runtime.GOOS == "windows" {
		nativeBridge, _, err := nativeinput.Start(program, os.Stderr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cyrene-v2 native-input: %v\n", err)
			if useNativeInput {
				program = tea.NewProgram(model, programOptions(model.MouseCapture, false)...)
			}
		}
		if nativeBridge != nil {
			defer func() {
				_ = nativeBridge.Close()
			}()
		}
	}

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

func programOptions(mouseCapture bool, useNativeInput bool) []tea.ProgramOption {
	options := []tea.ProgramOption{}
	if useNativeInput {
		options = append(options, tea.WithInput(nil))
	}
	if mouseCapture {
		options = append(options, tea.WithMouseCellMotion())
	}
	return options
}
