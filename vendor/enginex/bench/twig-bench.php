<?php
declare(strict_types=1);
$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_file($autoload)) {
    echo json_encode(['implementation' => 'Twig', 'available' => false, 'reason' => 'vendor/autoload.php not found; install twig/twig to include this benchmark.'], JSON_THROW_ON_ERROR);
    exit(0);
}
require $autoload;
if (!class_exists(\Twig\Environment::class)) {
    echo json_encode(['implementation' => 'Twig', 'available' => false, 'reason' => 'Twig is not installed.'], JSON_THROW_ON_ERROR);
    exit(0);
}
$iterations = max(1, min(1000000, (int)(getenv('ENGINEX_BENCH_ITERATIONS') ?: 20000)));
$warmup = max(1, min(100000, (int)(getenv('ENGINEX_BENCH_WARMUP') ?: min(1000, intdiv($iterations, 10) ?: 1))));
$loader = new \Twig\Loader\FilesystemLoader(__DIR__ . '/twig-templates');
$cacheDir = sys_get_temp_dir() . '/enginex-twig-bench-cache-v5';
$twig = new \Twig\Environment($loader, ['cache' => $cacheDir, 'auto_reload' => false, 'autoescape' => 'html', 'strict_variables' => true]);
$context = ['user' => ['name' => 'Ada & Lee'], 'products' => [
    ['name' => 'Notebook', 'price' => 8.5], ['name' => 'Pen & pencil', 'price' => 2.25], ['name' => 'Monitor', 'price' => 1234.5],
]];
for ($i = 0; $i < $warmup; $i++) $twig->render('sample.twig', $context);
$hash = hash_init('sha256');
$last = '';
$start = hrtime(true);
for ($i = 0; $i < $iterations; $i++) {
    $last = $twig->render('sample.twig', $context);
    hash_update($hash, $last);
}
$elapsedMs = (hrtime(true) - $start) / 1e6;
echo json_encode([
    'implementation' => 'Twig', 'available' => true, 'runtime' => PHP_VERSION,
    'iterations' => $iterations, 'warmup' => $warmup,
    'elapsedMs' => round($elapsedMs, 3), 'rendersPerSecond' => (int)round($iterations / ($elapsedMs / 1000)),
    'outputBytes' => strlen($last), 'outputHash' => hash_final($hash),
    'singleOutputHash' => hash('sha256', $last),
], JSON_THROW_ON_ERROR);
