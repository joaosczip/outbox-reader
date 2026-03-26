import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
const serviceName = process.env.OTEL_SERVICE_NAME ?? "outbox-reader";
const exportIntervalMs = Number(process.env.OTEL_METRICS_EXPORT_INTERVAL_MS ?? "30000");
const prometheusEnabled = (process.env.PROMETHEUS_EXPORTER_ENABLED ?? "true") === "true";

const resource = defaultResource().merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }));

// --- Metrics ---
const metricReader: MetricReader = prometheusEnabled
	? new PrometheusExporter()
	: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
			exportIntervalMillis: exportIntervalMs,
		});
const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
metrics.setGlobalMeterProvider(meterProvider);

// --- Logs ---
const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });
const loggerProvider = new LoggerProvider({
	resource,
	processors: [new BatchLogRecordProcessor(logExporter)],
});
logs.setGlobalLoggerProvider(loggerProvider);

export async function shutdownTelemetry(): Promise<void> {
	await Promise.all([meterProvider.shutdown(), loggerProvider.shutdown()]);
}
