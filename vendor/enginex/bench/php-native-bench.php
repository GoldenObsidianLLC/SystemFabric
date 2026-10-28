<?php
declare(strict_types=1);
$iterations = max(1, min(1000000, (int)(getenv('ENGINEX_BENCH_ITERATIONS') ?: 20000)));
$warmup = max(1, min(100000, (int)(getenv('ENGINEX_BENCH_WARMUP') ?: min(1000, intdiv($iterations, 10) ?: 1))));
$user = ['name' => 'Ada & Lee'];
$products = [
    ['name' => 'Notebook', 'price' => 8.5],
    ['name' => 'Pen & pencil', 'price' => 2.25],
    ['name' => 'Monitor', 'price' => 1234.5],
];
$template = __DIR__ . '/php-templates/sample.php';
function renderNativePhp(string $template, array $user, array $products): string {
    ob_start();
    include $template; // Included PHP template inherits this function's local variables.
    return (string)ob_get_clean();
}
for ($i = 0; $i < $warmup; $i++) renderNativePhp($template, $user, $products);
$hash = hash_init('sha256');
$last = '';
$start = hrtime(true);
for ($i = 0; $i < $iterations; $i++) {
    $last = renderNativePhp($template, $user, $products);
    hash_update($hash, $last);
}
$elapsedMs = (hrtime(true) - $start) / 1e6;
echo json_encode([
    'implementation' => 'Native PHP template', 'runtime' => PHP_VERSION,
    'opcacheCliEnabled' => extension_loaded('Zend OPcache') && (bool)ini_get('opcache.enable_cli'),
    'iterations' => $iterations, 'warmup' => $warmup,
    'elapsedMs' => round($elapsedMs, 3), 'rendersPerSecond' => (int)round($iterations / ($elapsedMs / 1000)),
    'outputBytes' => strlen($last), 'outputHash' => hash_final($hash),
    'singleOutputHash' => hash('sha256', $last),
], JSON_THROW_ON_ERROR);
