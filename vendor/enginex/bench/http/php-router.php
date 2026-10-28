<?php
declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($path === '/health') {
    header('Content-Type: text/plain');
    header('Cache-Control: no-store');
    echo 'ok';
    return;
}
if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'HEAD') {
    http_response_code(405);
    header('Allow: GET, HEAD');
    header('Cache-Control: no-store');
    echo 'Method Not Allowed';
    return;
}
$user = ['name' => 'Ada & Lee'];
$products = [
    ['name' => 'Notebook', 'price' => 8.5],
    ['name' => 'Pen & pencil', 'price' => 2.25],
    ['name' => 'Monitor', 'price' => 1234.5],
];

if ($path === '/native') {
    $template = dirname(__DIR__) . '/php-templates/sample.php';
    $html = renderNative($template, $user, $products);
    header('X-Template-Engine: native-php');
} elseif ($path === '/twig') {
    $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
    if (!is_file($autoload)) {
        http_response_code(503);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['available' => false, 'reason' => 'Twig is not installed (vendor/autoload.php missing).']);
        return;
    }
    require_once $autoload;
    if (!class_exists(\Twig\Environment::class)) {
        http_response_code(503);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['available' => false, 'reason' => 'Twig package is not installed.']);
        return;
    }
    $loader = new \Twig\Loader\FilesystemLoader(dirname(__DIR__) . '/twig-templates');
    $twig = new \Twig\Environment($loader, [
        'cache' => sys_get_temp_dir() . '/enginex-http-twig-cache-v610',
        'auto_reload' => false,
        'autoescape' => 'html',
        'strict_variables' => true,
    ]);
    $html = $twig->render('sample.twig', ['user' => $user, 'products' => $products]);
    header('X-Template-Engine: twig');
} else {
    http_response_code(404);
    header('Content-Type: text/plain');
    header('Cache-Control: no-store');
    echo 'Not Found';
    return;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('Content-Length: ' . strlen($html));
if ($_SERVER['REQUEST_METHOD'] === 'HEAD') return;
echo $html;

function renderNative(string $template, array $user, array $products): string {
    ob_start();
    include $template;
    return (string)ob_get_clean();
}
