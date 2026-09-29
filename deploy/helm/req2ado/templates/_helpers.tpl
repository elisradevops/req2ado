{{/*
Resource name prefix. Deliberately just .Release.Name (expected to be
"req2ado", matching production's existing release) rather than a
chart-name/release-name combo -- StatefulSet and PVC names below must stay
byte-for-byte identical to what's already running (req2ado-postgres,
req2ado-chroma) or `helm upgrade` orphans the live PVCs / fails outright on
the immutable volumeClaimTemplates field.
*/}}
{{- define "req2ado.fullname" -}}
{{ .Release.Name }}
{{- end }}

{{- define "req2ado.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/part-of: req2ado
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
{{- end }}

{{/*
Fully-qualified image reference. Usage:
  {{ include "req2ado.image" (dict "root" $ "repo" .Values.image.orchestrator.repository "tag" .Values.image.orchestrator.tag) }}
*/}}
{{- define "req2ado.image" -}}
{{- $registry := .root.Values.image.registry -}}
{{- if $registry -}}
{{ $registry }}/{{ .repo }}:{{ .tag }}
{{- else -}}
{{ .repo }}:{{ .tag }}
{{- end -}}
{{- end }}
