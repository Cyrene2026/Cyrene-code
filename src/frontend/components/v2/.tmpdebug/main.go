package main

import (
    "fmt"
    app "cyrenecode/v2/internal/app"
)

func main() {
    m := app.NewModel()
    m.Width = 170
    m.Height = 52
    m.ActivePanel = app.PanelSessions
    m.Items = []app.Message{{Role: "assistant", Kind: "transcript", Text: "ready"}}
    m.Sessions = []app.BridgeSession{{ID: "s1", Title: "one", UpdatedAt: "2026-04-11T00:00:00Z"}, {ID: "s2", Title: "two", UpdatedAt: "2026-04-10T00:00:00Z"}, {ID: "s3", Title: "three", UpdatedAt: "2026-04-09T00:00:00Z"}, {ID: "s4", Title: "four", UpdatedAt: "2026-04-08T00:00:00Z"}, {ID: "s5", Title: "five", UpdatedAt: "2026-04-07T00:00:00Z"}, {ID: "s6", Title: "six", UpdatedAt: "2026-04-06T00:00:00Z"}}
    fmt.Print(m.View())
}
