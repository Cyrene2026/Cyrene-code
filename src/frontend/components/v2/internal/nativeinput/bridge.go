package nativeinput

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"cyrenecode/v2/internal/app"
	tea "github.com/charmbracelet/bubbletea"
)

type Event struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Cursor int    `json:"cursor,omitempty"`
	Key    string `json:"key,omitempty"`
}

type msgSink interface {
	Send(tea.Msg)
}

type Bridge struct {
	cmd    *exec.Cmd
	stdout io.ReadCloser
}

func Available() bool {
	_, ok := detectCommand()
	return ok
}

func DecodeEvent(line []byte) (tea.Msg, bool, error) {
	var event Event
	if err := json.Unmarshal(line, &event); err != nil {
		return nil, false, err
	}
	switch strings.TrimSpace(event.Type) {
	case "composition_update":
		return app.ComposerCompositionMsg{Text: []rune(event.Text), Cursor: event.Cursor}, true, nil
	case "composition_commit":
		return app.ComposerCompositionCommitMsg{Text: []rune(event.Text)}, true, nil
	case "composition_clear":
		return app.ComposerCompositionClearMsg{}, true, nil
	case "text_input":
		runes := []rune(event.Text)
		if len(runes) == 0 {
			return nil, false, nil
		}
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: runes}, true, nil
	case "key":
		msg, ok := decodeKeyEvent(event.Key)
		if !ok {
			return nil, false, nil
		}
		return msg, true, nil
	default:
		return nil, false, nil
	}
}

func decodeKeyEvent(value string) (tea.KeyMsg, bool) {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}, true
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}, true
	case "delete":
		return tea.KeyMsg{Type: tea.KeyDelete}, true
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}, true
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}, true
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}, true
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}, true
	case "home":
		return tea.KeyMsg{Type: tea.KeyHome}, true
	case "end":
		return tea.KeyMsg{Type: tea.KeyEnd}, true
	case "escape":
		return tea.KeyMsg{Type: tea.KeyEscape}, true
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}, true
	case "space":
		return tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}, true
	case "ctrl+j":
		return tea.KeyMsg{Type: tea.KeyCtrlJ}, true
	case "ctrl+u":
		return tea.KeyMsg{Type: tea.KeyCtrlU}, true
	case "ctrl+k":
		return tea.KeyMsg{Type: tea.KeyCtrlK}, true
	case "ctrl+w":
		return tea.KeyMsg{Type: tea.KeyCtrlW}, true
	case "ctrl+d":
		return tea.KeyMsg{Type: tea.KeyCtrlD}, true
	default:
		return tea.KeyMsg{}, false
	}
}

func Start(program msgSink, stderr io.Writer) (*Bridge, bool, error) {
	command, ok := detectCommand()
	if !ok {
		return nil, false, nil
	}

	cmd := exec.Command(command.Path, command.Args...)
	if command.Dir != "" {
		cmd.Dir = command.Dir
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, fmt.Errorf("open native input bridge stdout: %w", err)
	}
	if stderr != nil {
		cmd.Stderr = stderr
	}
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		return nil, false, fmt.Errorf("start native input bridge: %w", err)
	}

	bridge := &Bridge{cmd: cmd, stdout: stdout}
	go bridge.pump(program, stderr)
	return bridge, true, nil
}

func (b *Bridge) pump(program msgSink, stderr io.Writer) {
	scanner := bufio.NewScanner(b.stdout)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 1024*1024)
	for scanner.Scan() {
		msg, ok, err := DecodeEvent(scanner.Bytes())
		if err != nil {
			if stderr != nil {
				fmt.Fprintf(stderr, "cyrene-v2 native-input: decode error: %v\n", err)
			}
			continue
		}
		if !ok {
			continue
		}
		program.Send(msg)
	}
	if err := scanner.Err(); err != nil && stderr != nil {
		fmt.Fprintf(stderr, "cyrene-v2 native-input: read error: %v\n", err)
	}
}

func (b *Bridge) Close() error {
	if b == nil {
		return nil
	}
	if b.stdout != nil {
		_ = b.stdout.Close()
	}
	if b.cmd == nil || b.cmd.Process == nil {
		return nil
	}
	_ = b.cmd.Process.Kill()
	_, err := b.cmd.Process.Wait()
	if err != nil {
		return err
	}
	return nil
}

type commandSpec struct {
	Path string
	Args []string
	Dir  string
}

func detectCommand() (commandSpec, bool) {
	if path := strings.TrimSpace(os.Getenv("CYRENE_NATIVE_INPUT_BRIDGE_PATH")); path != "" {
		args := strings.Fields(os.Getenv("CYRENE_NATIVE_INPUT_BRIDGE_ARGS"))
		return commandSpec{Path: path, Args: args}, true
	}

	execPath, err := os.Executable()
	if err == nil {
		if spec, ok := detectBinaryInDir(filepath.Dir(execPath)); ok {
			return spec, true
		}
	}

	if cwd, err := os.Getwd(); err == nil {
		if spec, ok := detectBinaryInDir(cwd); ok {
			return spec, true
		}
	}

	return commandSpec{}, false
}

func detectBinaryInDir(baseDir string) (commandSpec, bool) {
	candidates := []string{
		filepath.Join(baseDir, "cyrene-ime-bridge"),
		filepath.Join(baseDir, "cyrene-ime-bridge.exe"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return commandSpec{Path: candidate}, true
		}
	}
	return commandSpec{}, false
}
