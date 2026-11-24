<?php
/**
 * Caching proxy for the adsb.fi open API (PHP port of worker/index.mjs).
 * Reached as /api/adsb/v2/lat/{lat}/lon/{lon}/dist/{nm} through .htaccess.
 *   ?cache=long -> kept 2 min (corridor scans), otherwise 5 s (live view).
 * Errors are never cached.
 */
$path = $_GET['p'] ?? '';
if (!preg_match('#^/v2/lat/-?\d{1,2}(\.\d+)?/lon/-?\d{1,3}(\.\d+)?/dist/\d{1,3}$#', $path)) {
    http_response_code(404);
    exit('Not found');
}

$ttl = (($_GET['cache'] ?? '') === 'long') ? 120 : 5;
$dir = sys_get_temp_dir() . '/skymap-cache';
if (!is_dir($dir)) @mkdir($dir, 0700, true);
$file = $dir . '/' . md5($path) . '-' . $ttl . '.json';

header('Content-Type: application/json');

if (is_file($file) && time() - filemtime($file) < $ttl) {
    header('Cache-Control: public, max-age=' . $ttl);
    readfile($file);
    exit;
}

$ch = curl_init('https://opendata.adsb.fi/api' . $path);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_USERAGENT => 'skymap-proxy',
    CURLOPT_ENCODING => '',
]);
$body = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($body === false || $code !== 200) {
    // serve a stale copy rather than failing, if we have one
    if (is_file($file)) { header('Cache-Control: no-store'); readfile($file); exit; }
    http_response_code($code ?: 502);
    header('Cache-Control: no-store');
    exit('{"error":"upstream"}');
}

file_put_contents($file, $body, LOCK_EX);
header('Cache-Control: public, max-age=' . $ttl);
echo $body;
