package tests

import (
	"path/filepath"
	"testing"

	"cyrenecode/v2/internal/app"
)

func TestParseRootArg(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "long flag", args: []string{"--root", "../repo"}, want: "../repo"},
		{name: "short flag", args: []string{"-r", "./workspace"}, want: "./workspace"},
		{name: "equals form", args: []string{"--root=/tmp/project"}, want: "/tmp/project"},
		{name: "missing value", args: []string{"--root"}, want: ""},
		{name: "absent", args: []string{"--verbose"}, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := app.ParseRootArgForTest(tt.args); got != tt.want {
				t.Fatalf("ParseRootArgForTest(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestResolveRootPath(t *testing.T) {
	cwd := filepath.Join(string(filepath.Separator), "workspace", "current")
	if filepath.VolumeName(cwd) == "" && filepath.Separator == '\\' {
		cwd = filepath.Join("C:\\", "workspace", "current")
	}

	got, err := app.ResolveRootPathForTest(cwd, "../target")
	if err != nil {
		t.Fatalf("ResolveRootPathForTest returned error: %v", err)
	}
	want := filepath.Clean(filepath.Join(cwd, "..", "target"))
	if got != want {
		t.Fatalf("ResolveRootPathForTest returned %q, want %q", got, want)
	}
}
