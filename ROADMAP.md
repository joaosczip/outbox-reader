# Roadmap

The next features and enhancements to be made in this project.

## Feature Enhancements

1. Dead Letter Queue (DLQ)

- ~~Implement a separate storage for events that fail after maximum retries~~ _(done — `FAILED` status + `findFailedEvents()` + reprocess cronjob)_
- Add a UI to inspect and manually reprocess events from the DLQ

2. Multi-stream Support

- Allow publishing to different NATS streams based on event types or aggregates
- Support for stream partitioning strategies

3. Batched Publishing

- Implement batching of events to improve throughput
- Add configurable batch size and timeout settings

4. Configuration Management

- ~~Support multiple environment configurations~~ _(done — env-based config in `config.ts` and YAML publisher config)_
- Add dynamic configuration reloading without service restart

## Architectural Improvements

1. Event Enrichment Pipeline

- Add processing hooks to enrich events before publishing
- Support for injecting metadata or context information

2. Horizontal Scaling

- Implement leader election for multiple instances
- Support for sharded event processing across multiple nodes

3. Cloud-Native Features

- Add Kubernetes deployment manifests
- ~~Implement readiness/liveness probes for container orchestration~~ _(done — `/health` endpoint + graceful shutdown in `app.ts`)_

## Operational Improvements

1. Performance Testing Framework

- Build tooling to simulate high-load scenarios
- Create benchmarking utilities for optimizing performance

2. ~~Enhanced Monitoring & Observability~~ _(done — OpenTelemetry + Prometheus metrics + structured logging with correlation IDs in `telemetry.ts`, `metrics.ts`, `logger.ts`)_
