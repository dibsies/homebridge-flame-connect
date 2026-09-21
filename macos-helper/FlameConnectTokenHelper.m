#import <AppKit/AppKit.h>
#import <CommonCrypto/CommonDigest.h>
#import <CoreServices/CoreServices.h>
#import <Security/Security.h>

static NSString * const ClientID = @"1af761dc-085a-411f-9cb9-53e5e2115bd2";
static NSString * const CallbackScheme = @"msal1af761dc-085a-411f-9cb9-53e5e2115bd2";
static NSString * const RedirectURI = @"msal1af761dc-085a-411f-9cb9-53e5e2115bd2://auth";
static NSString * const Authority = @"https://gdhvb2cflameconnect.b2clogin.com/gdhvb2cflameconnect.onmicrosoft.com/B2C_1A_FirePhoneSignUpOrSignInWithPhoneOrEmail";
static NSString * const Scope = @"openid profile offline_access https://gdhvb2cflameconnect.onmicrosoft.com/Mobile/read";
static NSString * const HelperBundleID = @"com.dibsies.FlameConnectTokenHelper";

static NSString *Base64URL(NSData *data) {
    NSString *value = [data base64EncodedStringWithOptions:0];
    value = [value stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
    value = [value stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
    return [value stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

static NSString *RandomURLSafe(NSUInteger count) {
    NSMutableData *data = [NSMutableData dataWithLength:count];
    if (SecRandomCopyBytes(kSecRandomDefault, count, data.mutableBytes) != errSecSuccess) abort();
    return Base64URL(data);
}

static NSString *SHA256URLSafe(NSString *value) {
    NSData *input = [value dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(input.bytes, (CC_LONG)input.length, digest);
    return Base64URL([NSData dataWithBytes:digest length:sizeof(digest)]);
}

static NSDictionary<NSString *, NSString *> *QueryValues(NSURL *url) {
    NSMutableDictionary *values = [NSMutableDictionary dictionary];
    for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].queryItems ?: @[]) {
        values[item.name] = item.value ?: @"";
    }
    return values;
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property NSWindow *window;
@property NSTextField *statusLabel;
@property NSButton *tokenButton;
@property NSString *state;
@property NSString *verifier;
@property NSString *refreshToken;
@property NSString *previousHandler;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self buildWindow];
    if ([[NSProcessInfo processInfo].arguments containsObject:@"--self-test"]) {
        [self runSelfTest];
        return;
    }
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self startAuthorization];
}

- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    for (NSURL *url in urls) {
        if ([url.scheme isEqualToString:CallbackScheme]) {
            [self handleCallback:url];
            break;
        }
    }
}

- (void)applicationWillTerminate:(NSNotification *)notification { [self restoreHandler]; }

- (void)buildWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 540, 240)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
                                                backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Flame Connect Token Helper";
    [self.window center];

    NSTextField *title = [NSTextField labelWithString:@"Flame Connect sign-in"];
    title.font = [NSFont boldSystemFontOfSize:22];
    title.alignment = NSTextAlignmentCenter;
    self.statusLabel = [NSTextField wrappingLabelWithString:@"Preparing secure sign-in…"];
    self.statusLabel.alignment = NSTextAlignmentCenter;
    self.statusLabel.maximumNumberOfLines = 4;

    NSButton *start = [NSButton buttonWithTitle:@"Start Again" target:self action:@selector(startAuthorization)];
    start.bezelStyle = NSBezelStyleRounded;
    self.tokenButton = [NSButton buttonWithTitle:@"Copy Refresh Token" target:self action:@selector(copyToken)];
    self.tokenButton.bezelStyle = NSBezelStyleRounded;
    self.tokenButton.hidden = YES;

    NSStackView *buttons = [NSStackView stackViewWithViews:@[start, self.tokenButton]];
    buttons.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    buttons.spacing = 12;
    NSStackView *stack = [NSStackView stackViewWithViews:@[title, self.statusLabel, buttons]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.spacing = 22;
    stack.alignment = NSLayoutAttributeCenterX;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.window.contentView addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.leadingAnchor constraintEqualToAnchor:self.window.contentView.leadingAnchor constant:32],
        [stack.trailingAnchor constraintEqualToAnchor:self.window.contentView.trailingAnchor constant:-32],
        [stack.centerYAnchor constraintEqualToAnchor:self.window.contentView.centerYAnchor],
    ]];
}

- (NSURL *)authorizationURL {
    self.verifier = RandomURLSafe(48);
    self.state = RandomURLSafe(24);
    NSString *nonce = RandomURLSafe(24);
    NSURLComponents *components = [NSURLComponents componentsWithString:[Authority stringByAppendingString:@"/oauth2/v2.0/authorize"]];
    components.queryItems = @[
        [NSURLQueryItem queryItemWithName:@"client_id" value:ClientID],
        [NSURLQueryItem queryItemWithName:@"client_info" value:@"1"],
        [NSURLQueryItem queryItemWithName:@"response_type" value:@"code"],
        [NSURLQueryItem queryItemWithName:@"redirect_uri" value:RedirectURI],
        [NSURLQueryItem queryItemWithName:@"response_mode" value:@"query"],
        [NSURLQueryItem queryItemWithName:@"scope" value:Scope],
        [NSURLQueryItem queryItemWithName:@"state" value:self.state],
        [NSURLQueryItem queryItemWithName:@"nonce" value:SHA256URLSafe(nonce)],
        [NSURLQueryItem queryItemWithName:@"code_challenge" value:SHA256URLSafe(self.verifier)],
        [NSURLQueryItem queryItemWithName:@"code_challenge_method" value:@"S256"],
    ];
    return components.URL;
}

- (void)claimHandler {
    if (!self.previousHandler) {
        CFStringRef current = LSCopyDefaultHandlerForURLScheme((__bridge CFStringRef)CallbackScheme);
        if (current) {
            NSString *handler = CFBridgingRelease(current);
            if (![handler isEqualToString:HelperBundleID]) self.previousHandler = handler;
        }
    }
    LSSetDefaultHandlerForURLScheme((__bridge CFStringRef)CallbackScheme, (__bridge CFStringRef)HelperBundleID);
}

- (void)restoreHandler {
    if (self.previousHandler) {
        LSSetDefaultHandlerForURLScheme((__bridge CFStringRef)CallbackScheme, (__bridge CFStringRef)self.previousHandler);
        self.previousHandler = nil;
    }
}

- (void)startAuthorization {
    self.refreshToken = nil;
    self.tokenButton.hidden = YES;
    [self claimHandler];
    self.statusLabel.stringValue = @"Safari will open. Sign in, then choose Allow when asked to open this helper.";
    [[NSWorkspace sharedWorkspace] openURL:[self authorizationURL]];
}

- (void)handleCallback:(NSURL *)url {
    NSDictionary *values = QueryValues(url);
    NSString *error = values[@"error_description"] ?: values[@"error"];
    if (error.length) { [self showError:error]; return; }
    if (![values[@"state"] isEqualToString:self.state]) { [self showError:@"The security state did not match. Please start again."]; return; }
    NSString *code = values[@"code"];
    if (!code.length) { [self showError:@"The callback did not contain an authorization code."]; return; }
    self.statusLabel.stringValue = @"Finishing sign-in…";
    [self exchangeCode:code];
}

- (void)exchangeCode:(NSString *)code {
    NSURL *url = [NSURL URLWithString:[Authority stringByAppendingString:@"/oauth2/v2.0/token"]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/x-www-form-urlencoded" forHTTPHeaderField:@"Content-Type"];
    NSURLComponents *body = [[NSURLComponents alloc] init];
    body.queryItems = @[
        [NSURLQueryItem queryItemWithName:@"client_id" value:ClientID],
        [NSURLQueryItem queryItemWithName:@"client_info" value:@"1"],
        [NSURLQueryItem queryItemWithName:@"grant_type" value:@"authorization_code"],
        [NSURLQueryItem queryItemWithName:@"code" value:code],
        [NSURLQueryItem queryItemWithName:@"redirect_uri" value:RedirectURI],
        [NSURLQueryItem queryItemWithName:@"code_verifier" value:self.verifier],
        [NSURLQueryItem queryItemWithName:@"scope" value:Scope],
    ];
    request.HTTPBody = [body.percentEncodedQuery dataUsingEncoding:NSUTF8StringEncoding];
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *networkError) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (networkError) { [self showError:networkError.localizedDescription]; return; }
            NSDictionary *json = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            NSString *error = json[@"error_description"] ?: json[@"error"];
            if (error.length) { [self showError:error]; return; }
            NSString *token = json[@"refresh_token"];
            if (!token.length) { [self showError:@"Sign-in succeeded but no refresh token was returned."]; return; }
            self.refreshToken = token;
            [self restoreHandler];
            self.tokenButton.hidden = NO;
            self.statusLabel.stringValue = @"Success. Copy the refresh token, then paste it into Homebridge → Flame Connect → Refresh Token.";
            [NSApp activateIgnoringOtherApps:YES];
            [self.window makeKeyAndOrderFront:nil];
        });
    }] resume];
}

- (void)copyToken {
    if (!self.refreshToken.length) return;
    [[NSPasteboard generalPasteboard] clearContents];
    [[NSPasteboard generalPasteboard] setString:self.refreshToken forType:NSPasteboardTypeString];
    self.statusLabel.stringValue = @"Refresh token copied. Paste it into Homebridge → Flame Connect → Refresh Token.";
}

- (void)showError:(NSString *)message {
    self.statusLabel.stringValue = message ?: @"Unknown error";
    self.tokenButton.hidden = YES;
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)runSelfTest {
    NSURL *url = [self authorizationURL];
    NSDictionary *values = QueryValues(url);
    BOOL passed = [values[@"client_info"] isEqualToString:@"1"] &&
        [values[@"state"] isEqualToString:self.state] &&
        [values[@"redirect_uri"] isEqualToString:RedirectURI] &&
        [values[@"nonce"] length] > 0 && [values[@"code_challenge"] length] > 0;
    fprintf(stdout, "%s\n", passed ? "Self-test passed" : "Self-test failed");
    [NSApp terminate:nil];
    if (!passed) exit(1);
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
