package main

// The entry's lifecycle against the env. The suite runs beside this program, so the program binds an
// ephemeral port, announces that port to the env, serves until the env reports the trial is over, and
// then exits 0. A program that never registers leaves the env with nothing to test.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// How long one register or done request may take before it is abandoned and retried.
const requestTimeout = 30 * time.Second

// The retry schedule: a quarter second, doubling to the cap, for as long as the trial lasts.
const (
	retryInitial = 250 * time.Millisecond
	retryMax     = 2 * time.Second
)

// contractError is the env contradicting the contract, which ends the program instead of retrying.
type contractError struct{ message string }

func (e contractError) Error() string { return e.message }

// envUrl answers MAKEFUN_ENV_URL without its trailing slashes, or "" when it was not given.
func envUrl() string {
	return strings.TrimRight(os.Getenv("MAKEFUN_ENV_URL"), "/")
}

// retryDelay answers the wait after an attempt: exponential from the initial delay, then capped.
func retryDelay(attempt int) time.Duration {
	if attempt > 8 {
		attempt = 8
	}
	delay := retryInitial << attempt
	if delay > retryMax {
		return retryMax
	}
	return delay
}

// client is the one HTTP client the lifecycle uses: keep-alive off, so a retry is a new connection
// and never a stale one the env has already closed.
var client = &http.Client{Timeout: requestTimeout}

// register posts the bound port until the env accepts it. 200 is the ordinary answer and 409 means an
// earlier register already won, so both are done. 400 and 405 contradict the contract and end the
// program. A network error or any other status is retried, since the env may still be coming up.
func register(base string, port int) error {
	body, _ := json.Marshal(map[string]int{"port": port})
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest(http.MethodPost, base+"/register", bytes.NewReader(body))
		if err == nil {
			req.Header.Set("content-type", "application/json")
			if answer, err := client.Do(req); err == nil {
				_, _ = io.Copy(io.Discard, answer.Body)
				_ = answer.Body.Close()
				switch answer.StatusCode {
				case http.StatusOK, http.StatusConflict:
					return nil
				case http.StatusBadRequest, http.StatusMethodNotAllowed:
					return contractError{message: fmt.Sprintf("register answered HTTP %d", answer.StatusCode)}
				}
			}
		}
		time.Sleep(retryDelay(attempt))
	}
}

// waitForDone polls GET /done until the env reports that the trial is over.
func waitForDone(base string) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest(http.MethodGet, base+"/done", nil)
		if err == nil {
			if answer, err := client.Do(req); err == nil {
				body, _ := io.ReadAll(answer.Body)
				_ = answer.Body.Close()
				if answer.StatusCode == http.StatusOK {
					var parsed struct {
						Done bool `json:"done"`
					}
					if json.Unmarshal(body, &parsed) == nil && parsed.Done {
						return
					}
				}
			}
		}
		time.Sleep(retryDelay(attempt))
	}
}

// bind answers a listener on an ephemeral port, which is the port the env is told about. The
// listener takes every interface, as the TypeScript build's listen(0) does: the env's forwarder
// reaches this program from its own network, where a loopback-only bind is unreachable.
func bind() (net.Listener, int) {
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[entry] bind: %v\n", err)
		os.Exit(1)
	}
	return listener, listener.Addr().(*net.TCPAddr).Port
}

// bindPort answers a listener on the port asked for, or an ephemeral one when it is zero. The dev
// port stays on the loopback address, where only this host's tests reach it.
func bindPort(want int) (net.Listener, int) {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", want))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[entry] bind: %v\n", err)
		os.Exit(1)
	}
	return listener, listener.Addr().(*net.TCPAddr).Port
}

// storeRoot answers where this process keeps its repositories: the env's directory when it gave one,
// else a fresh temporary directory, which is what the TypeScript build does.
func storeRoot() string {
	if root := os.Getenv("MAKEFUN_STORE_DIR"); root != "" {
		return root
	}
	dir, err := os.MkdirTemp("", "forge-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[entry] store: %v\n", err)
		os.Exit(1)
	}
	return dir
}

// main binds the forge, registers the port, and waits for the trial to end.
func main() {
	base := envUrl()
	// a dev run names the port it wants and needs no env: the suite drives the binary directly, so
	// the only thing missing from a trial is the register and done handshake
	devPort := os.Getenv("MAKEFUN_DEV_PORT")
	if base == "" && devPort == "" {
		fmt.Fprintln(os.Stderr, "[entry] MAKEFUN_ENV_URL is not set: there is no env to register with")
		os.Exit(1)
	}

	token := os.Getenv("MAKEFUN_SHOP_TOKEN")
	if token == "" {
		token = "makefun-trial-token"
	}
	login := strings.TrimSpace(os.Getenv("MAKEFUN_SHOP_LOGIN"))
	if login == "" {
		login = "makefun"
	}

	root := storeRoot()
	forge := NewForge(root, token, login)
	forge.Load()
	fmt.Fprintln(os.Stderr, "[entry] store", root, "holds", forge.Count())
	server := &Server{Forge: forge}

	var listener net.Listener
	var port int
	if devPort != "" {
		listener, port = bindPort(parseInt(devPort))
	} else {
		listener, port = bind()
	}
	httpServer := &http.Server{Handler: server.Handler()}
	fmt.Printf("[entry] listening on port %d\n", port)

	// a stop signal writes the store out before the process leaves, so no change is lost
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stopping
		dirty.flush()
		os.Exit(0)
	}()

	go func() {
		if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "[entry] serve: %v\n", err)
			os.Exit(1)
		}
	}()

	if devPort != "" {
		// a dev run serves until its parent stops it; there is no env to poll
		select {}
	}

	if err := register(base, port); err != nil {
		fmt.Fprintf(os.Stderr, "[entry] %v\n", err)
		os.Exit(1)
	}
	fmt.Println("[entry] registered; waiting for the env to say done")

	waitForDone(base)
	// the trial is over: everything the forge changed is written before the process leaves
	dirty.flush()
	_ = httpServer.Close()
	fmt.Println("[entry] done")
}
