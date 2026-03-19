# Network Monitoring & Performance Analysis

## Network Requests

### List Requests

List all network requests since the last navigation:

```sh
chrome list_network_requests
```

Returns request URLs, methods, status codes, and timing.

### Inspect a Specific Request

```sh
chrome get_network_request --id req-123
```

Returns full details including headers, body, and response.

### Typical Network Debugging Workflow

1. Navigate to the page
2. Trigger the action that makes the network call
3. List requests to find the one you're interested in
4. Inspect the specific request for details

```sh
chrome navigate_page --url https://app.example.com/dashboard
chrome click --uid refresh-btn-5
chrome list_network_requests
# Find the API call in the list
chrome get_network_request --id req-42
```

## Performance Tracing

### Start / Stop a Trace

```sh
# Start recording
chrome performance_start_trace

# Do the actions you want to profile...
chrome navigate_page --url https://app.example.com/heavy-page

# Stop and get results
chrome performance_stop_trace
```

### Analyze Insights

After stopping a trace, you can analyze specific insights:

```sh
chrome performance_analyze_insight --insightId insight-1
```

## Memory Analysis

```sh
# Take a heap snapshot
chrome take_memory_snapshot
```

Useful for detecting memory leaks or understanding memory usage patterns.

## Lighthouse Audits

Run a full Lighthouse audit for accessibility, SEO, and best practices:

```sh
chrome lighthouse_audit
```

Returns scores and specific recommendations for improvement.

## Typical Performance Analysis Workflow

1. Navigate to the target page
2. Start a performance trace
3. Perform the user actions to profile
4. Stop the trace
5. Analyze the results

```sh
chrome navigate_page --url https://app.example.com
chrome performance_start_trace
chrome click --uid load-data-btn-3
chrome wait_for --text "Data loaded"
chrome performance_stop_trace
# Review the trace output for bottlenecks
```
