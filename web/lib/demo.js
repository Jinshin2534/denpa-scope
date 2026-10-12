// 実機が読めないときの作り物のデータ。画面に「デモ」と必ず出す前提。
export function createDemo(send) {
  const nets = [
    { ssid: 'home-5G', channel: 44, band: 2, width: 3, base: -58 },
    { ssid: 'home-5G-guest', channel: 44, band: 2, width: 3, base: -58 },
    { ssid: 'apt-201', channel: 44, band: 2, width: 3, base: -71 },
    { ssid: 'apt-305', channel: 44, band: 2, width: 2, base: -77 },
    { ssid: 'shop-free', channel: 40, band: 2, width: 1, base: -79 },
    { ssid: 'apt-102', channel: 44, band: 2, width: 1, base: -88 },
    { ssid: 'home-2G', channel: 6, band: 1, width: 1, base: -55 },
    { ssid: 'neighbor-a', channel: 1, band: 1, width: 1, base: -78 },
    { ssid: 'neighbor-b', channel: 11, band: 1, width: 1, base: -84 },
    { ssid: 'neighbor-c', channel: 36, band: 2, width: 3, base: -80 },
    { ssid: 'office', channel: 100, band: 2, width: 2, base: -86 },
    { ssid: 'cafe-6', channel: 37, band: 3, width: 4, base: -74 },
  ];
  let phase = 0;
  return {
    start() {
      setInterval(() => {
        phase += 0.1;
        const fade = 6 * Math.sin(phase / 3) + 3 * Math.sin(phase * 1.7);
        send({
          type: 'link', t: Date.now(), iface: 'demo0', power: true,
          rssi: Math.round(-58 + fade + (Math.random() - 0.5) * 4),
          noise: -92 + (Math.random() < 0.05 ? 1 : 0),
          rate: 866, txPower: 1496, phy: 5, channel: 44, band: 2, width: 3, ssid: 'home-5G',
        });
      }, 100);
      const scan = () => send({
        type: 'scan', t: Date.now(), durationMs: 3000,
        nets: nets.map(({ base, ...n }) => ({ ...n, rssi: Math.round(base + (Math.random() - 0.5) * 6) })),
      });
      setTimeout(scan, 300);
      setInterval(scan, 8000);
    },
  };
}
