'use strict';

const TRACE_ID_RE = /^(?!0{32}$)[0-9a-f]{32}$/;
const SPAN_ID_RE = /^(?!0{16}$)[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

module.exports = {
  TRACE_ID_RE,
  SPAN_ID_RE,
  TRACE_FLAGS_RE,
  REQUEST_ID_RE
};
