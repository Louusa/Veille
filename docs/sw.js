self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : { title: "Veille", body: "Nouveau résumé disponible." };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: "icon.svg", tag: "veille" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow("./index.html"));
});
