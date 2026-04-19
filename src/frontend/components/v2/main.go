package main

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"cyrenecode/v2/internal/app"
	"cyrenecode/v2/internal/nativeinput"
	tea "github.com/charmbracelet/bubbletea"
	term "github.com/charmbracelet/x/term"
)

func main() {
	model := app.NewModel()
	useNativeInput := runtime.GOOS == "windows" && nativeinput.Available()
	program := tea.NewProgram(model, programOptions(model.MouseCapture, useNativeInput)...)
	var nativeBridge *nativeinput.Bridge
	if runtime.GOOS == "windows" {
		var err error
		nativeBridge, _, err = nativeinput.Start(program, os.Stderr)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cyrene-v2 native-input: %v\n", err)
			if useNativeInput {
				useNativeInput = false
				program = tea.NewProgram(model, programOptions(model.MouseCapture, false)...)
			}
		}
	}
	var stopWindowSizeSync chan struct{}
	if useNativeInput {
		stopWindowSizeSync = make(chan struct{})
		go syncWindowSize(program, os.Stdout, stopWindowSizeSync)
		defer close(stopWindowSizeSync)
	}
	if nativeBridge != nil {
		defer func() {
			_ = nativeBridge.Close()
		}()
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

func syncWindowSize(program *tea.Program, output *os.File, stop <-chan struct{}) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	lastWidth := -1
	lastHeight := -1

	sendIfChanged := func() {
		if output == nil {
			return
		}
		width, height, err := term.GetSize(output.Fd())
		if err != nil || width <= 0 || height <= 0 {
			return
		}
		if width == lastWidth && height == lastHeight {
			return
		}
		lastWidth = width
		lastHeight = height
		program.Send(tea.WindowSizeMsg{Width: width, Height: height})
	}

	sendIfChanged()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			sendIfChanged()
		}
	}
}
