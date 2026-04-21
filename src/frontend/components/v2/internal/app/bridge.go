package app

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const bridgeShutdownGrace = 8 * time.Second

type bridgeCommand struct {
	Type            string       `json:"type"`
	Root            string       `json:"root,omitempty"`
	Text            string       `json:"text,omitempty"`
	Attachments     []Attachment `json:"attachments,omitempty"`
	ID              string       `json:"id,omitempty"`
	Value           string       `json:"value,omitempty"`
	Name            string       `json:"name,omitempty"`
	Profile         string       `json:"profile,omitempty"`
	Format          string       `json:"format,omitempty"`
	ProviderType    string       `json:"providerType,omitempty"`
	Kind            string       `json:"kind,omitempty"`
	Endpoint        string       `json:"endpoint,omitempty"`
	ProviderBaseURL string       `json:"providerBaseUrl,omitempty"`
	APIKey          string       `json:"apiKey,omitempty"`
	Model           string       `json:"model,omitempty"`
}

type BridgeReview struct {
	ID             string `json:"id"`
	Action         string `json:"action"`
	Path           string `json:"path"`
	PreviewSummary string `json:"previewSummary"`
	PreviewFull    string `json:"previewFull"`
	CreatedAt      string `json:"createdAt"`
}

type BridgeSession struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	UpdatedAt   string   `json:"updatedAt"`
	ProjectRoot string   `json:"projectRoot,omitempty"`
	Tags        []string `json:"tags"`
}

type BridgeAuthStatus struct {
	Mode              string `json:"mode"`
	CredentialSource  string `json:"credentialSource"`
	Provider          string `json:"provider"`
	Model             string `json:"model"`
	PersistenceLabel  string `json:"persistenceLabel"`
	PersistencePath   string `json:"persistencePath"`
	HTTPReady         bool   `json:"httpReady"`
	OnboardingEnabled bool   `json:"onboardingAvailable"`
}

type BridgeUsageSummary struct {
	Requests         int `json:"requests"`
	PromptTokens     int `json:"promptTokens"`
	CachedTokens     int `json:"cachedTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

type BridgeManagedSkill struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Exposure string `json:"exposure"`
	Source   string `json:"source"`
}

type BridgeManagedMcpServer struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Exposure string `json:"exposure"`
	Scope    string `json:"scope"`
	Trusted  bool   `json:"trusted"`
}

type BridgePlanStep struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	Details          string   `json:"details"`
	Status           string   `json:"status"`
	Evidence         []string `json:"evidence"`
	FilePaths        []string `json:"filePaths"`
	RecentToolResult string   `json:"recentToolResult"`
}

type BridgeExecutionPlan struct {
	CapturedAt      string           `json:"capturedAt"`
	SourcePreview   string           `json:"sourcePreview"`
	ProjectRoot     string           `json:"projectRoot"`
	Summary         string           `json:"summary"`
	Objective       string           `json:"objective"`
	AcceptedAt      string           `json:"acceptedAt"`
	AcceptedSummary string           `json:"acceptedSummary"`
	Steps           []BridgePlanStep `json:"steps"`
}

type BridgeRequestTiming struct {
	Active    bool   `json:"active"`
	StartedAt string `json:"startedAt"`
	ElapsedMs int64  `json:"elapsedMs"`
}

type bridgeSnapshot struct {
	AppRoot                  string                       `json:"appRoot"`
	Status                   string                       `json:"status"`
	ActiveSessionID          string                       `json:"activeSessionId"`
	Items                    []Message                    `json:"items"`
	LiveText                 string                       `json:"liveText"`
	RequestTiming            BridgeRequestTiming          `json:"requestTiming"`
	ExecutionPlan            *BridgeExecutionPlan         `json:"executionPlan"`
	PendingReviews           []BridgeReview               `json:"pendingReviews"`
	Sessions                 []BridgeSession              `json:"sessions"`
	CurrentModel             string                       `json:"currentModel"`
	CurrentProvider          string                       `json:"currentProvider"`
	CurrentProviderFormat    string                       `json:"currentProviderFormat"`
	CurrentProviderKeySource string                       `json:"currentProviderKeySource"`
	AvailableModels          []string                     `json:"availableModels"`
	AvailableProviders       []string                     `json:"availableProviders"`
	ProviderProfiles         map[string]string            `json:"providerProfiles"`
	ProviderFormats          map[string]string            `json:"providerFormats"`
	ProviderEndpoints        map[string]map[string]string `json:"providerEndpoints"`
	ProviderProfileSources   map[string]string            `json:"providerProfileSources"`
	ProviderNames            map[string]string            `json:"providerNames"`
	ManagedSkills            []BridgeManagedSkill         `json:"managedSkills"`
	ManagedMcpServers        []BridgeManagedMcpServer     `json:"managedMcpServers"`
	UsageSummary             BridgeUsageSummary           `json:"usageSummary"`
	Auth                     BridgeAuthStatus             `json:"auth"`
}

type bridgeEvent struct {
	Type                     string                       `json:"type"`
	Snapshot                 *bridgeSnapshot              `json:"snapshot,omitempty"`
	Message                  string                       `json:"message,omitempty"`
	Status                   string                       `json:"status,omitempty"`
	LiveText                 string                       `json:"liveText,omitempty"`
	RequestTiming            BridgeRequestTiming          `json:"requestTiming,omitempty"`
	ExecutionPlan            *BridgeExecutionPlan         `json:"executionPlan,omitempty"`
	Items                    []Message                    `json:"items,omitempty"`
	Sessions                 []BridgeSession              `json:"sessions,omitempty"`
	ActiveSessionID          string                       `json:"activeSessionId,omitempty"`
	PendingReviews           []BridgeReview               `json:"pendingReviews,omitempty"`
	CurrentModel             string                       `json:"currentModel,omitempty"`
	CurrentProvider          string                       `json:"currentProvider,omitempty"`
	CurrentProviderFormat    string                       `json:"currentProviderFormat,omitempty"`
	CurrentProviderKeySource string                       `json:"currentProviderKeySource,omitempty"`
	AvailableModels          []string                     `json:"availableModels,omitempty"`
	AvailableProviders       []string                     `json:"availableProviders,omitempty"`
	ProviderProfiles         map[string]string            `json:"providerProfiles,omitempty"`
	ProviderFormats          map[string]string            `json:"providerFormats,omitempty"`
	ProviderEndpoints        map[string]map[string]string `json:"providerEndpoints,omitempty"`
	ProviderProfileSources   map[string]string            `json:"providerProfileSources,omitempty"`
	ProviderNames            map[string]string            `json:"providerNames,omitempty"`
	ManagedSkills            []BridgeManagedSkill         `json:"managedSkills,omitempty"`
	ManagedMcpServers        []BridgeManagedMcpServer     `json:"managedMcpServers,omitempty"`
	UsageSummary             BridgeUsageSummary           `json:"usageSummary,omitempty"`
	Auth                     BridgeAuthStatus             `json:"auth,omitempty"`
	AppRoot                  string                       `json:"appRoot,omitempty"`
	ProviderBaseURL          string                       `json:"providerBaseUrl,omitempty"`
	Model                    string                       `json:"model,omitempty"`
	APIKey                   string                       `json:"apiKey,omitempty"`
	ProviderType             string                       `json:"providerType,omitempty"`
}

type bridgeStartedMsg struct {
	Client *bridgeClient
}

type bridgeEventMsg struct {
	Event bridgeEvent
}

type bridgeErrorMsg struct {
	Message string
}

type bridgeExitedMsg struct {
	Err error
}

type bridgeClient struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	events    chan tea.Msg
	exitDone  chan struct{}
	closeOnce sync.Once
	exited    atomic.Bool
	mu        sync.Mutex
}

func startBridgeCmd() tea.Cmd {
	return func() tea.Msg {
		client, err := startBridge()
		if err != nil {
			return bridgeErrorMsg{Message: err.Error()}
		}
		return bridgeStartedMsg{Client: client}
	}
}

func waitForBridgeEvent(client *bridgeClient) tea.Cmd {
	if client == nil {
		return nil
	}
	return func() tea.Msg {
		msg, ok := <-client.events
		if !ok {
			return nil
		}
		return msg
	}
}

func sendBridgeCommand(client *bridgeClient, command bridgeCommand) tea.Cmd {
	if client == nil {
		return nil
	}
	return func() tea.Msg {
		if err := client.Send(command); err != nil {
			return bridgeErrorMsg{Message: err.Error()}
		}
		return nil
	}
}

func startBridge() (*bridgeClient, error) {
	repoRoot, err := detectRepoRoot()
	if err != nil {
		return nil, err
	}
	launchRoot, err := resolveLaunchRoot()
	if err != nil {
		return nil, err
	}

	bridgePath := filepath.Join(repoRoot, "src", "frontend", "components", "v2", "bridge.ts")
	if _, err := os.Stat(bridgePath); err != nil {
		return nil, fmt.Errorf("bridge.ts not found at %s", bridgePath)
	}

	cmd := exec.Command("bun", bridgePath, "--root", launchRoot)
	cmd.Dir = repoRoot

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open bridge stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open bridge stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("open bridge stderr: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start bridge: %w", err)
	}

	client := &bridgeClient{
		cmd:      cmd,
		stdin:    stdin,
		events:   make(chan tea.Msg, 128),
		exitDone: make(chan struct{}),
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go client.scanStdout(stdout, &wg)
	go client.scanStderr(stderr, &wg)
	go client.waitForExit(&wg)

	return client, nil
}

func (c *bridgeClient) Send(command bridgeCommand) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.stdin == nil || c.exited.Load() {
		return errors.New("bridge is not running")
	}

	payload, err := json.Marshal(command)
	if err != nil {
		return fmt.Errorf("encode bridge command: %w", err)
	}
	if _, err := c.stdin.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write bridge command: %w", err)
	}
	return nil
}

func (c *bridgeClient) Close() {
	c.closeOnce.Do(func() {
		_ = c.Send(bridgeCommand{Type: "shutdown"})

		c.mu.Lock()
		stdin := c.stdin
		c.stdin = nil
		c.mu.Unlock()

		if stdin != nil {
			_ = stdin.Close()
		}

		if c.exited.Load() || c.cmd == nil || c.cmd.Process == nil {
			return
		}

		select {
		case <-c.exitDone:
			return
		case <-time.After(bridgeShutdownGrace):
		}

		if !c.exited.Load() {
			_ = c.cmd.Process.Kill()
			select {
			case <-c.exitDone:
			case <-time.After(250 * time.Millisecond):
			}
		}
	})
}

func (c *bridgeClient) scanStdout(reader io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()

	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 0, 64*1024)
	scanner.Buffer(buffer, 8*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var event bridgeEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			c.events <- bridgeErrorMsg{Message: fmt.Sprintf("decode bridge event: %v", err)}
			continue
		}
		c.events <- bridgeEventMsg{Event: event}
	}

	if err := scanner.Err(); err != nil && !c.exited.Load() {
		c.events <- bridgeErrorMsg{Message: fmt.Sprintf("bridge stdout error: %v", err)}
	}
}

func (c *bridgeClient) scanStderr(reader io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()

	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 0, 16*1024)
	scanner.Buffer(buffer, 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		c.events <- bridgeErrorMsg{Message: fmt.Sprintf("bridge stderr: %s", line)}
	}
}

func (c *bridgeClient) waitForExit(wg *sync.WaitGroup) {
	err := c.cmd.Wait()
	c.exited.Store(true)
	close(c.exitDone)
	wg.Wait()

	if err != nil && strings.Contains(err.Error(), "killed") {
		err = nil
	}
	c.events <- bridgeExitedMsg{Err: err}
	close(c.events)
}

func (e bridgeEvent) appRoot() string {
	switch e.Type {
	case "init":
		if e.Snapshot != nil {
			return strings.TrimSpace(e.Snapshot.AppRoot)
		}
	case "set_runtime_metadata":
		return strings.TrimSpace(e.AppRoot)
	}
	return ""
}

func detectRepoRoot() (string, error) {
	seen := map[string]bool{}
	starts := make([]string, 0, 2)

	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	if executable, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(executable))
	}

	for _, start := range starts {
		if start == "" {
			continue
		}
		dir := filepath.Clean(start)
		for {
			if seen[dir] {
				break
			}
			seen[dir] = true

			if looksLikeRepoRoot(dir) {
				return dir, nil
			}

			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	return "", errors.New("unable to locate Cyrene repo root for v2 bridge")
}

func resolveLaunchRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}

	if argRoot := parseRootArg(os.Args[1:]); argRoot != "" {
		return resolveRootPath(cwd, argRoot)
	}

	if envRoot := strings.TrimSpace(os.Getenv("CYRENE_ROOT")); envRoot != "" {
		return resolveRootPath(cwd, envRoot)
	}

	return filepath.Clean(cwd), nil
}

func parseRootArg(args []string) string {
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		if token == "" {
			continue
		}
		if token == "--root" || token == "-r" {
			if index+1 < len(args) {
				return strings.TrimSpace(args[index+1])
			}
			return ""
		}
		if strings.HasPrefix(token, "--root=") {
			return strings.TrimSpace(strings.TrimPrefix(token, "--root="))
		}
	}
	return ""
}

func resolveRootPath(cwd, raw string) (string, error) {
	if raw == "" {
		return filepath.Clean(cwd), nil
	}
	if filepath.IsAbs(raw) {
		return filepath.Clean(raw), nil
	}
	return filepath.Abs(filepath.Join(cwd, raw))
}

func looksLikeRepoRoot(dir string) bool {
	required := []string{
		filepath.Join(dir, "package.json"),
		filepath.Join(dir, "src", "frontend", "components", "v2", "bridge.ts"),
	}

	for _, path := range required {
		if _, err := os.Stat(path); err != nil {
			return false
		}
	}
	return true
}
