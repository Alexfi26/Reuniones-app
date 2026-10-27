# Configurar Microsoft Entra ID y Microsoft Graph

## 1. Registrar la aplicación

1. Entra en <https://entra.microsoft.com> → **Identidad → Aplicaciones → Registros de
   aplicaciones → Nuevo registro**.
2. Nombre: `reuniones-app`. Tipos de cuenta: *Cuentas en cualquier directorio de la organización
   y cuentas personales de Microsoft* (o solo tu directorio, según tu caso).
3. En **Autenticación → Agregar plataforma → Aplicaciones móviles y de escritorio**, marca
   `http://localhost` como URI de redirección. La app usa un puerto aleatorio en localhost, que
   Entra admite para esta plataforma.
4. Activa **Permitir flujos de cliente público** si tu tenant lo solicita.
5. Copia el **Id. de aplicación (cliente)** en `config.json` (`microsoft.clientId`). Si usas un
   solo tenant, pon su ID en `microsoft.tenant`; si no, deja `common`.

## 2. Permisos de Microsoft Graph (delegados)

| Permiso | Para qué |
|---|---|
| `openid`, `offline_access` | Inicio de sesión y refresh token |
| `User.Read` | Mostrar la cuenta conectada |
| `Calendars.Read` | Leer el calendario |

No se solicitan permisos de correo, de escritura ni de Teams. **Verifica el permiso exacto de
`calendarView` en Microsoft Learn antes de publicar**: no pudo confirmarse en la búsqueda de
la Fase 1.

Si tu organización exige consentimiento de administrador, el administrador debe aprobarlo en
**Permisos de API → Conceder consentimiento de administrador**.

## 3. Conexión

```bash
node dist/src/cli/main.js connect microsoft --login-hint tu.correo@empresa.com
```

## 4. Requisito en Outlook

Para que los enlaces de Teams aparezcan en `onlineMeeting`, el proveedor «Teams para empresas»
debe estar habilitado para el usuario. Si no lo está, la reunión aparecerá sin enlace y la app
la ignorará. Es un ajuste del administrador de Microsoft 365, no un permiso de la app.

## 5. Revocar el acceso

`reuniones disconnect <cuenta> --yes` borra los tokens locales. Para revocar el consentimiento
en la nube, usa <https://account.live.com/consent/Manage> o *Aplicaciones empresariales* en
Entra.
