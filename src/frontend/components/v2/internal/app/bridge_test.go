package app

import "testing"

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
			if got := parseRootArg(tt.args); got != tt.want {
				t.Fatalf("parseRootArg(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestResolveRootPath(t *testing.T) {
	got, err := resolveRootPath("/workspace/current", "../target")
	if err != nil {
		t.Fatalf("resolveRootPath returned error: %v", err)
	}
	if got != "/workspace/target" {
		t.Fatalf("resolveRootPath returned %q, want %q", got, "/workspace/target")
	}
}
